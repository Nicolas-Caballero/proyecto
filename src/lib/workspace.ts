import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import type {
  DashboardCompany, DashboardData, DashboardJob, DashboardRequest, Industry, RuleKey,
} from "@/components/dashboard-types";
import { AccessDeniedError, listMemberships, transaction, withTenant } from "./db";
import { applyPreset } from "./presets";
import {
  computeBusinessDue, defaultRules, defaultTemplates, handleRequestCreated, queueInformationRequest, reconcileRequestJobs, retryJob,
} from "./automation";
import { isValidEmail, mailMode } from "./mail";
import { normalizeSource } from "./public";

// Error de negocio con un mensaje que la API puede mostrar junto a su código HTTP.
export class WorkspaceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Identidad obtenida de la sesión y nombres que vinculan cada regla de la interfaz con su trabajo en el servidor.
type Viewer = { id: string; email: string; demo: boolean };
const ruleNames = {
  acknowledgment: "acknowledgement", sla: "delay", information: "information",
  quoteFollowup: "quote", appointmentReminder: "appointment",
} as const;

// Validaciones reutilizables para los identificadores, textos, opciones y formatos que envía el navegador.
const uuid = z.uuid();
const text = (limit: number) => z.string().trim().min(1).max(limit);
const optionalText = (limit: number) => z.string().trim().max(limit);
const role = z.enum(["admin", "employee"]);
const priority = z.enum(["low", "normal", "high"]);
const industry = z.enum(["salon", "workshop", "renovation", "custom"]);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// Una regla combina un interruptor y una plantilla editable. Las fechas pueden omitirse o borrarse.
const enabled = z.object({ enabled: z.boolean(), template: optionalText(4000) });
const dateInput = z.string().max(35).nullable().optional();
// El logotipo puede quedar vacío. Una URL externa debe usar HTTPS y carecer de credenciales incrustadas.
const url = z.union([
  z.literal(""),
  z.url({ protocol: /^https$/ }).max(2000).refine((value) => {
    if (!URL.canParse(value)) return false;
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  }),
]);

// Valida la configuración completa antes de tocar la base de datos.
const companySettings = z.object({
  name: text(120), logoUrl: url, color, timezone: text(80).refine((zone) => DateTime.now().setZone(zone).isValid),
  // Los días van del domingo (0) al sábado (6). La apertura debe preceder al cierre.
  businessHours: z.object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: time, end: time,
  }).refine(({ start, end }) => start < end),
  // Limita el formulario y exige opciones cuando un campo es una lista desplegable.
  services: z.array(text(120)).max(50),
  fields: z.array(z.object({
    id: text(100), label: text(160),
    type: z.enum(["text", "textarea", "select", "date", "email", "tel", "number", "checkbox"]),
    required: z.boolean(), options: z.array(text(160)).max(30).optional(),
  }).refine((field) => field.type !== "select" || Boolean(field.options?.length))).max(35),
  // La empresa necesita al menos un estado para recibir solicitudes y otro para cerrarlas.
  statuses: z.array(z.object({
    id: text(100), label: text(100), color, kind: z.enum(["open", "waiting", "quote", "appointment", "closed"]),
  })).min(2).max(30).refine((statuses) => statuses.some((status) => status.kind === "open") &&
    statuses.some((status) => status.kind === "closed")),
  // El plazo de primera respuesta y el aviso de cita se expresan en minutos. El seguimiento se expresa en días.
  rules: z.object({
    acknowledgment: enabled,
    sla: enabled.extend({ delay: z.number().int().min(1).max(43200).optional() }),
    information: enabled,
    quoteFollowup: enabled.extend({ delay: z.number().int().min(1).max(365).optional(), automatic: z.boolean().optional() }),
    appointmentReminder: enabled.extend({ delay: z.number().int().min(1).max(43200).optional() }),
  }),
});

// El campo action indica a Zod qué estructura debe validar para cada operación del panel.
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("createCompany"), name: text(120), industry }),
  z.object({
    action: z.literal("createRequest"), name: text(160), email: z.union([z.email().max(254), z.literal("")]),
    phone: optionalText(40), service: optionalText(120), origin: text(80), priority,
    data: z.record(z.string().max(64), z.string().max(2000)),
  }),
  z.object({
    // En una edición parcial, los campos omitidos conservan su valor y los campos anulables aceptan null para borrarlo.
    action: z.literal("updateRequest"), requestId: uuid, status: uuid.optional(), priority: priority.optional(),
    assigneeId: uuid.nullable().optional(), followupAt: dateInput, appointmentAt: dateInput,
    outcome: z.enum(["won", "lost"]).optional(),
    amount: z.number().finite().min(0).max(9999999999.99).nullable().optional(),
    lostReason: optionalText(1000).nullable().optional(), nextAction: optionalText(300).nullable().optional(),
  }),
  z.object({
    action: z.literal("addEvent"), requestId: uuid, kind: z.enum(["note", "contact", "completeFollowup"]),
    text: optionalText(4000), followupId: uuid.optional(),
  }),
  z.object({ action: z.literal("requestInfo"), requestId: uuid, fields: z.array(text(100)).min(1).max(35) }),
  z.object({ action: z.literal("updateCompany"), settings: companySettings }),
  z.object({ action: z.literal("deleteRequest"), requestId: uuid }),
  z.object({ action: z.literal("retryJob"), jobId: uuid }),
  z.object({ action: z.literal("addMember"), email: z.email().max(254), role }),
]);

// Infiere el tipo TypeScript a partir de la misma validación que se usa en ejecución.
type WorkspaceAction = z.infer<typeof actionSchema>;

// Convierte las fechas de PostgreSQL en cadenas UTC que se pueden enviar como JSON.
function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

// Interpreta una fecha de entrada en el horario de la empresa y la convierte a UTC para guardarla.
function datetime(value: string | null, timezone: string) {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid) throw new WorkspaceError("Introduce una fecha válida.");
  return parsed.toUTC().toISO();
}

// Prepara el texto que la interfaz muestra para las respuestas del formulario, incluidas las casillas.
function stringAnswers(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key, typeof value === "boolean" ? (value ? "Sí" : "No") : typeof value === "string" || typeof value === "number"
      ? String(value) : "",
  ]));
}

// Carga la empresa con el cliente de base de datos recibido. Un identificador inexistente devuelve un 404.
async function companyRow(client: PoolClient, companyId: string) {
  const { rows } = await client.query("SELECT * FROM companies WHERE id = $1", [companyId]);
  if (!rows[0]) throw new WorkspaceError("Empresa no encontrada.", 404);
  return rows[0];
}

// Construye los datos iniciales del panel con las empresas a las que pertenece el usuario.
export async function readWorkspace(user: Viewer, selected?: string | null): Promise<DashboardData> {
  const memberships = await listMemberships(user.id);
  const companyOptions: DashboardData["companies"] = memberships.map((member) => ({
    id: member.company_id, slug: member.company_slug, name: member.company_name, role: member.role,
    industry: member.industry as Industry,
  }));
  // Resuelve la empresa de la URL dentro de las permitidas. Sin selección, abre la primera disponible.
  const active = selected ? companyOptions.find((company) => company.slug === selected || company.id === selected) : companyOptions[0];
  if (selected && !active) throw new AccessDeniedError();

  // Prepara también el estado vacío de quien inicia sesión antes de crear su primera empresa.
  const base: DashboardData = {
    viewer: { id: user.id, name: memberships[0]?.name || user.email.split("@")[0], email: user.email },
    companies: companyOptions, company: null, members: [], requests: [], jobs: [],
    mode: user.demo ? "demo" : "live", mailMode: mailMode() === "resend" ? "live" : "simulated",
  };
  if (!active) return base;
  // Ejecuta las consultas con los permisos de esta empresa. PostgreSQL aplica el aislamiento por fila.
  return withTenant(user.id, active.id, async (client, membership) => {
    const row = await companyRow(client, active.id);
    // Recupera las opciones del formulario, los estados del proceso y los miembros del equipo.
    const services = await client.query("SELECT name FROM services WHERE company_id = $1 AND active ORDER BY position, name", [active.id]);
    const fields = await client.query("SELECT key, label, type, required, options FROM form_fields WHERE company_id = $1 ORDER BY position, key", [active.id]);
    const statuses = await client.query("SELECT id, name AS label, color, kind FROM statuses WHERE company_id = $1 ORDER BY position, name", [active.id]);
    const members = await client.query("SELECT user_id AS id, name, email, role FROM memberships WHERE company_id = $1 ORDER BY name", [active.id]);
    // Agrupa en cada solicitud su historial y sus seguimientos. Un historial vacío se devuelve como lista vacía.
    const requests = await client.query(
      `SELECT r.*, s.name AS service,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind,
          'text', e.body, 'actor', COALESCE(m.name, CASE WHEN e.kind IN
            ('created','public_submission','information_received','customer_reply') THEN 'Cliente' ELSE 'Sistema' END),
          'at', e.created_at) ORDER BY e.created_at, e.id)
         FROM events e LEFT JOIN memberships m ON m.company_id = e.company_id AND m.user_id = e.author_id
         WHERE e.company_id = r.company_id AND e.request_id = r.id), '[]') AS activity,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'createdAt', f.created_at,
          'completedAt', f.completed_at, 'message', f.message, 'dueAt', f.due_at,
          'assignedTo', f.assigned_to) ORDER BY f.created_at)
         FROM follow_ups f WHERE f.company_id = r.company_id AND f.request_id = r.id), '[]') AS followups
       FROM requests r LEFT JOIN services s ON s.company_id = r.company_id AND s.id = r.service_id
       WHERE r.company_id = $1 ORDER BY r.updated_at DESC, r.id`, [active.id],
    );
    // Carga las ejecuciones recientes con su estado, número de intentos y último error.
    const jobs = await client.query(
      "SELECT id, request_id, type, status, available_at, attempts, last_error FROM jobs WHERE company_id = $1 ORDER BY created_at DESC LIMIT 300",
      [active.id],
    );
    // Combina las reglas guardadas con los valores predeterminados y adapta los nombres al contrato del panel.
    const rules = { ...defaultRules, ...row.rules };
    const templates = { ...defaultTemplates, ...row.templates };
    const dashboardRules = Object.fromEntries(Object.entries(ruleNames).map(([key, kind]) =>
      [key, { enabled: Boolean(rules[kind]), template: templates[kind] ?? "" }],
    )) as DashboardCompany["rules"];
    dashboardRules.sla.delay = row.first_response_minutes;
    dashboardRules.quoteFollowup.delay = rules.quoteDays;
    dashboardRules.quoteFollowup.automatic = rules.quoteAutoSend;
    dashboardRules.appointmentReminder.delay = rules.appointmentMinutes;
    const hours = row.business_hours;

    return {
      ...base,
      viewer: { ...base.viewer, name: membership.name },
      company: {
        ...active, role: membership.role, name: row.name, logoUrl: row.logo_url || "", color: row.primary_color, timezone: row.timezone,
        businessHours: { weekdays: hours.days, start: hours.start, end: hours.end },
        services: services.rows.map((service) => service.name),
        fields: fields.rows.map((field) => ({ ...field, id: field.key })),
        statuses: statuses.rows,
        rules: dashboardRules,
      },
      members: members.rows,
      // Convierte fechas e importes al formato del navegador y normaliza el origen mostrado.
      requests: requests.rows.map((request): DashboardRequest => ({
        id: request.id, name: request.name, email: request.email || "", phone: request.phone || "",
        service: request.service || request.subject, subject: request.subject, origin: normalizeSource(request.source), status: request.status_id,
        priority: request.priority === "urgent" ? "high" : request.priority, assigneeId: request.assigned_to,
        createdAt: iso(request.created_at)!, updatedAt: iso(request.updated_at)!, firstResponseAt: iso(request.first_response_at),
        slaDueAt: iso(request.sla_due_at), followupAt: iso(request.next_action_at), appointmentAt: iso(request.appointment_at),
        nextAction: request.next_action, closedAt: iso(request.closed_at), outcome: request.outcome,
        amount: request.confirmed_amount === null ? null : Number(request.confirmed_amount),
        lostReason: request.loss_reason, data: stringAnswers(request.answers), events: request.activity, followups: request.followups,
      })),
      // Traduce los nombres internos de los trabajos y sus estados a los que usa el panel.
      jobs: jobs.rows.flatMap((job): DashboardJob[] => {
        const kind = Object.entries(ruleNames).find(([, value]) => value === (job.type === "quote_email" ? "quote" : job.type))?.[0] as RuleKey | undefined;
        if (!kind) return [];
        const status = job.status === "completed" ? "done" : job.status === "cancelled" ? "canceled" : job.status;
        return [{ id: job.id, requestId: job.request_id, kind, status, runAt: iso(job.available_at)!,
          attempts: job.attempts, error: job.last_error }];
      }),
    };
  });
}

// Añade al historial una acción con el autor y la solicitud a la que pertenece.
async function logEvent(
  client: PoolClient, company: string, request: string, user: string, kind: string, body: string,
) {
  await client.query(
    "INSERT INTO events (company_id, request_id, author_id, kind, body) VALUES ($1,$2,$3,$4,$5)",
    [company, request, user, kind, body],
  );
}

// Genera la parte legible de la URL a partir del nombre, eliminando acentos y caracteres especiales.
function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "empresa";
}

// Crea la empresa, su primer administrador y sus plantillas en una sola transacción.
async function createCompany(user: Viewer, name: string, kind: Industry) {
  return transaction(async (client) => {
    const base = slugify(name);
    // El sufijo aleatorio permite que dos negocios con el mismo nombre tengan enlaces distintos.
    const slug = `${base}-${randomUUID().slice(0, 8)}`;
    const { rows: [company] } = await client.query(
      "INSERT INTO companies (slug, name, industry) VALUES ($1,$2,$3) RETURNING id",
      [slug, name, kind],
    );
    await client.query(
      "INSERT INTO memberships (company_id, user_id, role, name, email) VALUES ($1,$2,'admin',$3,$4)",
      [company.id, user.id, user.email.split("@")[0], user.email],
    );
    await applyPreset(client, company.id, kind);
    return { company: slug };
  });
}

// Comprueba que el identificador o nombre corto recibido corresponde a una membresía del usuario.
async function selectTenant(user: Viewer, selector: string) {
  const member = (await listMemberships(user.id)).find((entry) => entry.company_slug === selector || entry.company_id === selector);
  if (!member) throw new AccessDeniedError();
  return member.company_id;
}

// Registra una solicitud manual desde el panel y programa el mismo flujo inicial que para un formulario público.
async function createRequest(
  client: PoolClient, company: Awaited<ReturnType<typeof companyRow>>, actor: string,
  action: Extract<WorkspaceAction, { action: "createRequest" }>,
) {
  // Exige un medio de contacto y toma como estado inicial el primer estado abierto de la empresa.
  if (!action.email && !action.phone) throw new WorkspaceError("Indica un correo o un teléfono de contacto.");
  const status = await client.query(
    "SELECT id FROM statuses WHERE company_id = $1 AND kind = 'open' ORDER BY position LIMIT 1", [company.id],
  );
  if (!status.rows[0]) throw new WorkspaceError("Configura un estado abierto antes de crear solicitudes.");
  // Comprueba que el servicio seleccionado esté activo y pertenezca a esta empresa.
  const service = action.service && (await client.query(
    "SELECT id FROM services WHERE company_id = $1 AND active AND name = $2 ORDER BY position LIMIT 1",
    [company.id, action.service],
  )).rows[0];
  if (action.service && !service) throw new WorkspaceError("El servicio seleccionado no está disponible.");
  // Guarda únicamente respuestas con claves presentes en el formulario de esta empresa.
  const fields = await client.query("SELECT key FROM form_fields WHERE company_id = $1", [company.id]);
  const known = new Set(fields.rows.map((field) => field.key));
  const answers = Object.fromEntries(Object.entries(action.data).filter(([key]) => known.has(key)));
  // Calcula el plazo de respuesta usando el horario local y usa la misma fecha para los hitos iniciales.
  const createdAt = new Date();
  const due = computeBusinessDue(createdAt, company.timezone, company.business_hours, company.first_response_minutes);
  const { rows: [request] } = await client.query(
    `INSERT INTO requests (company_id, status_id, service_id, name, email, phone, subject, answers, priority, source,
       sla_due_at, created_at, updated_at, state_changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING *`,
    [company.id, status.rows[0].id, service ? service.id : null, action.name, action.email || null,
      action.phone || null, action.service || "Solicitud manual", JSON.stringify(answers), action.priority, normalizeSource(action.origin), due, createdAt],
  );
  // Registra el alta y prepara las automatizaciones dentro de la transacción de la solicitud.
  await logEvent(client, company.id, request.id, actor, "created", "Solicitud registrada desde el panel.");
  await handleRequestCreated(client, company, request);
  return { requestId: request.id };
}

// Aplica una edición parcial a una solicitud previamente bloqueada en la transacción.
async function updateRequest(
  client: PoolClient, company: Awaited<ReturnType<typeof companyRow>>, actor: string,
  request: Awaited<ReturnType<typeof lockRequest>>, action: Extract<WorkspaceAction, { action: "updateRequest" }>,
) {
  // Un resultado ganado o perdido selecciona un estado que se pueda usar para el cierre.
  let statusId = action.status ?? request.status_id;
  if (action.outcome) {
    const closed = await client.query(
      "SELECT id FROM statuses WHERE company_id = $1 AND kind = 'closed' ORDER BY (id = $2) DESC, position LIMIT 1",
      [company.id, statusId],
    );
    if (!closed.rows[0]) throw new WorkspaceError("Configura un estado de cierre primero.");
    statusId = closed.rows[0].id;
  }
  // El estado y el responsable deben pertenecer a la misma empresa que la solicitud.
  const status = (await client.query("SELECT kind, name FROM statuses WHERE company_id = $1 AND id = $2", [company.id, statusId])).rows[0];
  if (!status) throw new WorkspaceError("Selecciona un estado de esta empresa.");
  if (action.assigneeId && !(await client.query(
    "SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2", [company.id, action.assigneeId],
  )).rowCount) throw new WorkspaceError("Selecciona a un miembro de esta empresa.");

  // Conserva las fechas omitidas y convierte las indicadas. Salir del estado de cita cancela la cita anterior si mantiene la misma fecha.
  const followUpDate = action.followupAt === undefined ? request.next_action_at : datetime(action.followupAt, company.timezone);
  let appointment = action.appointmentAt === undefined ? request.appointment_at : datetime(action.appointmentAt, company.timezone);
  if (status.kind !== "appointment" && statusId !== request.status_id && iso(appointment) === iso(request.appointment_at)) {
    const previous = await client.query("SELECT kind FROM statuses WHERE company_id = $1 AND id = $2", [company.id, request.status_id]);
    if (previous.rows[0]?.kind === "appointment") appointment = null;
  }
  // Prepara los valores finales de la edición. El importe solo se conserva para una victoria y el motivo para una pérdida.
  const nextAction = action.nextAction === undefined ? request.next_action : action.nextAction || null;
  const assignedTo = action.assigneeId === undefined ? request.assigned_to : action.assigneeId;
  const closed = status.kind === "closed";
  const outcome = closed ? action.outcome ?? request.outcome : null;
  const amount = outcome === "won" ? action.amount === undefined ? request.confirmed_amount : action.amount : null;
  const reason = outcome === "lost" ? action.lostReason === undefined ? request.loss_reason : action.lostReason || null : null;

  // Actualiza las fechas de cambio de estado y cierre cuando corresponde, además de la última actividad.
  const { rows: [updated] } = await client.query(
    `UPDATE requests SET status_id = $3, priority = $4, assigned_to = $5,
       next_action_at = $6, appointment_at = $7, outcome = $8, confirmed_amount = $9,
       loss_reason = $10, next_action = $11,
       state_changed_at = CASE WHEN status_id <> $3 THEN now() ELSE state_changed_at END,
       closed_at = CASE WHEN $12 THEN coalesce(closed_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE company_id = $1 AND id = $2 RETURNING *`,
    [company.id, request.id, statusId, action.priority ?? request.priority, assignedTo, followUpDate,
      appointment, outcome, amount, reason, nextAction, closed],
  );
  // Resume los cambios para guardar una única entrada en el historial.
  const details = [];
  if (statusId !== request.status_id) details.push(`Estado: ${status.name}`);
  if (outcome !== request.outcome && outcome) details.push(outcome === "won" ? "Solicitud conseguida" : "Solicitud perdida");
  if (assignedTo !== request.assigned_to) {
    const { rows } = await client.query("SELECT name FROM memberships WHERE company_id = $1 AND user_id = $2", [company.id, assignedTo]);
    details.push(rows[0] ? `Responsable: ${rows[0].name}` : "Se retiró el responsable");
  }
  if (action.priority && action.priority !== request.priority) details.push("Se cambió la prioridad");
  if (iso(appointment) !== iso(request.appointment_at)) details.push(appointment ? "Se programó una cita" : "Se canceló la cita");
  if (iso(followUpDate) !== iso(request.next_action_at)) details.push(followUpDate ? "Se programó un seguimiento" : "Se quitó el seguimiento");
  if (action.nextAction !== undefined && nextAction !== request.next_action) details.push(nextAction ? `Siguiente acción: ${nextAction}` : "Se quitó la siguiente acción");
  if (action.amount !== undefined || action.lostReason !== undefined) details.push("Se actualizaron los datos del cierre");
  if (details.length) await logEvent(client, company.id, request.id, actor, "updated", details.join(" · "));
  // Revisa los trabajos pendientes para que respeten las nuevas fechas y el estado de la solicitud.
  await reconcileRequestJobs(client, company, updated);
  // Reasigna también al nuevo responsable los seguimientos todavía pendientes.
  if (assignedTo !== request.assigned_to) {
    await client.query("UPDATE follow_ups SET assigned_to = $3 WHERE company_id = $1 AND request_id = $2 AND completed_at IS NULL",
      [company.id, request.id, assignedTo]);
  }
}

// Bloquea la fila para evitar que dos operaciones modifiquen a la vez la misma solicitud.
async function lockRequest(client: PoolClient, company: string, id: string) {
  const { rows } = await client.query("SELECT * FROM requests WHERE company_id = $1 AND id = $2 FOR UPDATE", [company, id]);
  if (!rows[0]) throw new WorkspaceError("Solicitud no encontrada.", 404);
  return rows[0];
}

// Guarda los cambios de configuración de la empresa y actualiza las automatizaciones afectadas.
async function updateCompany(
  client: PoolClient, companyId: string, settings: z.infer<typeof companySettings>,
) {
  // Rechaza identificadores y nombres duplicados antes de aplicar la configuración.
  const services = [...new Set(settings.services)];
  if (services.length !== settings.services.length) throw new WorkspaceError("Cada servicio necesita un nombre único.");
  const fieldIds = settings.fields.map((field) => field.id);
  const statusIds = settings.statuses.map((status) => status.id);
  if (new Set(fieldIds).size !== fieldIds.length || new Set(statusIds).size !== statusIds.length) {
    throw new WorkspaceError("No se pueden guardar campos o estados duplicados.");
  }

  // Lee las claves actuales para distinguir nuevas opciones de ediciones sobre opciones existentes.
  const { rows: previousStatuses } = await client.query("SELECT id, kind FROM statuses WHERE company_id = $1", [companyId]);
  const previousById = new Map(previousStatuses.map((status) => [status.id, status.kind]));
  const previousFields = new Set((await client.query(
    "SELECT key FROM form_fields WHERE company_id = $1", [companyId],
  )).rows.map((field) => field.key));

  // Protege las solicitudes existentes contra el borrado de su estado o un cambio que altere su condición de cierre.
  for (const previous of previousStatuses) {
    const next = settings.statuses.find((status) => status.id === previous.id);
    if (!next || (next.kind !== previous.kind && (next.kind === "closed" || previous.kind === "closed"))) {
      const { rowCount } = await client.query("SELECT 1 FROM requests WHERE company_id = $1 AND status_id = $2 LIMIT 1",
        [companyId, previous.id]);
      if (rowCount) throw new WorkspaceError("Mueve las solicitudes a otro estado antes de eliminar su estado o cambiar su tipo de cierre.");
    }
  }

  // Convierte las reglas, las plantillas y el horario al formato que lee el motor de automatización.
  const rules = {
    acknowledgement: settings.rules.acknowledgment.enabled,
    delay: settings.rules.sla.enabled,
    information: settings.rules.information.enabled,
    quote: settings.rules.quoteFollowup.enabled,
    quoteDays: settings.rules.quoteFollowup.delay ?? defaultRules.quoteDays,
    quoteAutoSend: settings.rules.quoteFollowup.automatic ?? false,
    appointment: settings.rules.appointmentReminder.enabled,
    appointmentMinutes: settings.rules.appointmentReminder.delay ?? defaultRules.appointmentMinutes,
  };
  const templates = Object.fromEntries(Object.entries(ruleNames).map(([key, kind]) =>
    [kind, settings.rules[key as RuleKey].template || defaultTemplates[kind]],
  ));
  const businessHours = { days: [...new Set(settings.businessHours.weekdays)], start: settings.businessHours.start, end: settings.businessHours.end };
  const { rows: [company] } = await client.query(
    `UPDATE companies SET name = $2, logo_url = $3, primary_color = $4, timezone = $5, business_hours = $6,
       first_response_minutes = $7, rules = $8, templates = $9 WHERE id = $1 RETURNING *`,
    [companyId, settings.name, settings.logoUrl || null, settings.color, settings.timezone,
      businessHours, settings.rules.sla.delay ?? 120, rules, templates],
  );

  // Desactiva los servicios retirados del formulario y reutiliza los existentes por nombre para conservar sus referencias.
  const existingServices = (await client.query(
    "SELECT id, name FROM services WHERE company_id = $1 ORDER BY active DESC, position", [companyId],
  )).rows;
  await client.query("UPDATE services SET active = false WHERE company_id = $1 AND active", [companyId]);
  for (const [position, name] of services.entries()) {
    const previous = existingServices.find((service) => service.name === name);
    if (previous) {
      await client.query("UPDATE services SET active = true, position = $3 WHERE company_id = $1 AND id = $2",
        [companyId, previous.id, position]);
    } else {
      await client.query("INSERT INTO services (company_id, name, position) VALUES ($1,$2,$3)", [companyId, name, position]);
    }
  }

  // Retira los campos borrados y actualiza los demás, manteniendo las claves de las respuestas guardadas.
  await client.query("DELETE FROM form_fields WHERE company_id = $1 AND NOT (key = ANY($2::text[]))", [companyId, fieldIds]);
  for (const [position, field] of settings.fields.entries()) {
    const key = previousFields.has(field.id) ? field.id : `campo_${randomUUID().replaceAll("-", "")}`;
    await client.query(
      `INSERT INTO form_fields (company_id, key, label, type, required, options, position) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, key) DO UPDATE SET label = excluded.label, type = excluded.type,
         required = excluded.required, options = excluded.options, position = excluded.position`,
      [companyId, key, field.label, field.type, field.required, JSON.stringify(field.options ?? []), position],
    );
  }

  // Actualiza o inserta los estados según su identificador y su posición en el panel.
  for (const [position, status] of settings.statuses.entries()) {
    if (previousById.has(status.id)) {
      await client.query(
        "UPDATE statuses SET name = $3, kind = $4, color = $5, position = $6 WHERE company_id = $1 AND id = $2",
        [companyId, status.id, status.label, status.kind, status.color, position],
      );
    } else {
      await client.query(
        "INSERT INTO statuses (company_id, name, kind, color, position) VALUES ($1,$2,$3,$4,$5)",
        [companyId, status.label, status.kind, status.color, position],
      );
    }
  }
  const removed = previousStatuses.filter(({ id }) => !statusIds.includes(id)).map(({ id }) => id);
  await client.query("DELETE FROM statuses WHERE company_id = $1 AND id = ANY($2::uuid[])", [companyId, removed]);
  // Vuelve a calcular la programación de las solicitudes abiertas con la configuración recién guardada.
  const { rows: openRequests } = await client.query(
    "SELECT * FROM requests WHERE company_id = $1 AND closed_at IS NULL ORDER BY id FOR UPDATE", [companyId],
  );
  for (const request of openRequests) await reconcileRequestJobs(client, company, request);
}

// Operaciones que requieren el rol de administrador. La comprobación se hace al abrir la transacción.
const adminActions: ReadonlySet<WorkspaceAction["action"]> = new Set(["updateCompany", "deleteRequest", "addMember", "retryJob"]);

// Valida la petición del cliente y ejecuta la operación con los permisos de la empresa seleccionada.
export async function mutateWorkspace(user: Viewer, input: unknown) {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) throw new WorkspaceError("Revisa los campos y los formatos antes de guardar.");
  const action = parsed.data;
  if (action.action === "createCompany") return createCompany(user, action.name, action.industry);
  // Crear una empresa es una operación inicial. Las demás acciones necesitan una empresa accesible para el usuario.
  const selector = (input as { company?: unknown }).company;
  if (typeof selector !== "string") throw new WorkspaceError("Selecciona una empresa.");
  const companyId = await selectTenant(user, selector);
  return withTenant(user.id, companyId, async (client) => {
    const company = await companyRow(client, companyId);
    switch (action.action) {
      case "createRequest":
        return createRequest(client, company, user.id, action);
      case "updateCompany":
        await updateCompany(client, companyId, action.settings);
        return { ok: true };
      // El borrado se limita a la empresa activa y avisa si la solicitud ya no existe.
      case "deleteRequest": {
        const { rowCount } = await client.query("DELETE FROM requests WHERE company_id = $1 AND id = $2", [companyId, action.requestId]);
        if (!rowCount) throw new WorkspaceError("Solicitud no encontrada.", 404);
        return { ok: true };
      }
      // Devuelve a la cola un trabajo que terminó con error y se puede volver a ejecutar.
      case "retryJob":
        if (!await retryJob(client, action.jobId)) throw new WorkspaceError("No se encontró un trabajo fallido para reintentar.", 404);
        return { ok: true };
      // Guarda una invitación asociada al email. La membresía se crea al confirmar esa identidad en Supabase.
      case "addMember": {
        const email = action.email.toLowerCase();
        const { rowCount } = await client.query(
          "SELECT 1 FROM memberships WHERE company_id = $1 AND lower(email) = $2", [companyId, email],
        );
        if (rowCount) throw new WorkspaceError("Esta persona ya pertenece a la empresa.", 409);
        await client.query(
          `INSERT INTO company_invitations (company_id, email, role, name) VALUES ($1,$2,$3,$4)
           ON CONFLICT (company_id, email) DO UPDATE SET role = excluded.role`,
          [companyId, email, action.role, email.split("@")[0]],
        );
        return { ok: true };
      }
      case "updateRequest": {
        const request = await lockRequest(client, companyId, action.requestId);
        await updateRequest(client, company, user.id, request, action);
        return { ok: true };
      }
      // Comprueba que la solicitud pueda recibir correo y que los campos solicitados pertenezcan a la empresa.
      case "requestInfo": {
        const request = await lockRequest(client, companyId, action.requestId);
        if (request.closed_at || !isValidEmail(request.email) || company.rules.information === false) {
          throw new WorkspaceError("La solicitud debe estar abierta, tener correo y tener activada la regla de información pendiente.");
        }
        const fields = await client.query(
          "SELECT key FROM form_fields WHERE company_id = $1 AND key = ANY($2::text[])",
          [companyId, [...new Set(action.fields)]],
        );
        if (fields.rows.length !== new Set(action.fields).size) throw new WorkspaceError("Selecciona campos de esta empresa.");
        await queueInformationRequest(client, { company, request, actorId: user.id, fieldIds: action.fields });
        return { ok: true };
      }
      // Registra una nota, un contacto con el cliente o la finalización de un seguimiento.
      case "addEvent": {
        const request = await lockRequest(client, companyId, action.requestId);
        let message = action.text;
        // Un seguimiento automático tiene su propia fila. Para uno manual se borra la siguiente acción de la solicitud.
        if (action.kind === "completeFollowup") {
          if (action.followupId) {
            const { rowCount } = await client.query(
              `UPDATE follow_ups SET completed_at = now()
               WHERE company_id = $1 AND request_id = $2 AND id = $3 AND completed_at IS NULL`,
              [companyId, request.id, action.followupId],
            );
            if (!rowCount) throw new WorkspaceError("El seguimiento ya se completó o no está disponible.", 409);
          } else if (request.next_action_at) {
            await client.query("UPDATE requests SET next_action_at = NULL, next_action = NULL WHERE company_id = $1 AND id = $2", [companyId, request.id]);
          } else {
            throw new WorkspaceError("No hay un seguimiento pendiente para completar.");
          }
          message ||= "Seguimiento completado.";
        }
        // Solo un contacto fija la primera respuesta y lo hace una vez. Una nota no cuenta como respuesta.
        if (!message) throw new WorkspaceError("Escribe un texto para registrar la actividad.");
        await logEvent(client, companyId, request.id, user.id, action.kind, message);
        const { rows: [updated] } = await client.query(
          `UPDATE requests SET updated_at = now(),
               first_response_at = CASE WHEN $3 THEN COALESCE(first_response_at, now()) ELSE first_response_at END
           WHERE company_id = $1 AND id = $2 RETURNING *`,
          [companyId, request.id, action.kind === "contact"],
        );
        if (action.kind === "contact") await reconcileRequestJobs(client, company, updated);
        return { ok: true };
      }
    }
  }, adminActions.has(action.action) ? "admin" : undefined);
}

// Escapa las comillas del CSV y evita que los programas de hoja de cálculo interpreten entradas como fórmulas.
function csvCell(input: unknown) {
  let value = input == null ? "" : input instanceof Date ? input.toISOString() : String(input);
  if (/^\s*[=+@-]|^[\t\r\n]/.test(value)) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
}

// Exporta las solicitudes de una empresa y exige que el usuario sea su administrador.
export async function exportWorkspace(user: Viewer, selected: string) {
  const companyId = await selectTenant(user, selected);
  return withTenant(user.id, companyId, async (client) => {
    const { rows } = await client.query(
      `SELECT r.id, r.name, r.email, r.phone, r.subject, s.name AS estado, r.priority, r.source,
              m.name AS responsable, r.next_action, r.next_action_at, r.appointment_at, r.created_at,
              r.first_response_at, r.sla_due_at, r.closed_at, r.outcome, r.confirmed_amount, r.loss_reason, r.answers::text
       FROM requests r
       JOIN statuses s ON s.company_id = r.company_id AND s.id = r.status_id
       LEFT JOIN memberships m ON m.company_id = r.company_id AND m.user_id = r.assigned_to
       WHERE r.company_id = $1 ORDER BY r.created_at DESC`, [companyId],
    );
    // El encabezado sigue el orden del SELECT. La marca UTF-8 facilita leer los acentos en Excel.
    const columns = [
      "ID", "Nombre", "Correo", "Teléfono", "Solicitud", "Estado", "Prioridad", "Origen", "Responsable",
      "Siguiente acción", "Seguimiento UTC", "Cita UTC", "Recibida UTC", "Primera respuesta UTC",
      "Vencimiento UTC", "Cerrada UTC", "Resultado", "Importe", "Motivo de pérdida", "Datos del formulario",
    ];
    return "\uFEFF" + [columns.map(csvCell).join(","), ...rows.map((row) => Object.values(row).map(csvCell).join(","))].join("\r\n");
  }, "admin");
}

// Traduce errores esperados a códigos HTTP y usa un mensaje genérico para fallos internos.
export function workspaceErrorResponse(error: unknown) {
  if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof AccessDeniedError) return Response.json({ error: error.message }, { status: 403 });
  if (error instanceof SyntaxError) return Response.json({ error: "La solicitud no tiene un formato válido." }, { status: 400 });
  if (typeof error === "object" && error && "code" in error && error.code === "23503") {
    return Response.json({ error: "La configuración cambió mientras editabas. Recarga y vuelve a intentarlo." }, { status: 409 });
  }
  console.error(error instanceof Error ? error.message : "Error en el espacio de trabajo.");
  return Response.json({ error: "No se pudo completar la operación." }, { status: 500 });
}
