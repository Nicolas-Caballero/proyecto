// Las automatizaciones usan PostgreSQL para la cola y delegan el envío al adaptador de correo.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { computeBusinessDue, type BusinessHours } from "./business-time";
import { listWorkerCompanyIds, withWorkerCompany } from "./db";
import { applicationUrl, deliverMail, isValidEmail, type MailMessage } from "./mail";

// Reexporta el horario laboral para los módulos que preparan solicitudes y empresas.
export { computeBusinessDue, defaultBusinessHours } from "./business-time";
export type { BusinessHours } from "./business-time";

// Cada empresa decide qué reglas ejecuta y con qué plazos. Los días se usan para el presupuesto y los minutos
// para la cita.
export type AutomationRules = {
  acknowledgement: boolean;
  delay: boolean;
  information: boolean;
  quote: boolean;
  quoteDays: number;
  quoteAutoSend: boolean;
  appointment: boolean;
  appointmentMinutes: number;
};

// El seguimiento de un presupuesto puede crear un segundo trabajo de envío con su propio estado y reintentos.
type MessageType = "acknowledgement" | "delay" | "information" | "quote" | "appointment";
export type MessageTemplates = Record<MessageType, string>;
export type JobType = MessageType | "quote_email";

// Estos valores completan la configuración de cada empresa cuando aún faltan opciones guardadas.
export const defaultRules: AutomationRules = {
  acknowledgement: true,
  delay: true,
  information: true,
  quote: true,
  quoteDays: 3,
  quoteAutoSend: false,
  appointment: true,
  appointmentMinutes: 1440,
};

// Los marcadores entre llaves se rellenan con datos de la empresa, la solicitud y el trabajo.
export const defaultTemplates: MessageTemplates = {
  acknowledgement: "Hola {{nombre}}, hemos recibido tu solicitud «{{solicitud}}». Te responderemos en aproximadamente {{plazo}} dentro de nuestro horario laboral. Gracias, {{empresa}}.",
  delay: "La solicitud «{{solicitud}}» de {{nombre}} ha superado el objetivo de primera respuesta de {{empresa}}.",
  information: "Hola {{nombre}}, necesitamos estos datos para continuar con tu solicitud: {{campos}}. Puedes completarlos aquí: {{enlace}}. Gracias, {{empresa}}.",
  quote: "Hola {{nombre}}, ¿has podido revisar el presupuesto de «{{solicitud}}»? Si tienes dudas, escríbenos. Gracias, {{empresa}}.",
  appointment: "Hola {{nombre}}, te recordamos tu cita con {{empresa}} el {{cita}}. Si necesitas cambiarla, contacta con nosotros.",
};

// Configura la automatización con los datos de la empresa a la que pertenece la solicitud.
export type AutomationCompany = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  business_hours: BusinessHours;
  first_response_minutes: number;
  rules: Partial<AutomationRules>;
  templates: Partial<MessageTemplates>;
};

// Crear los trabajos iniciales solo requiere los datos que ya se conocen al dar de alta la solicitud.
export type NewAutomationRequest = {
  id: string;
  company_id: string;
  name: string;
  email: string | null;
  subject: string;
  created_at: Date | string;
};

// Las fechas adicionales determinan si un trabajo programado sigue siendo necesario.
export type AutomationRequest = NewAutomationRequest & {
  status_id: string;
  assigned_to: string | null;
  first_response_at: Date | string | null;
  sla_due_at: Date | string | null;
  state_changed_at: Date | string;
  appointment_at: Date | string | null;
  closed_at: Date | string | null;
};

// El tipo de estado se usa para evaluar las reglas aunque la empresa cambie el nombre visible de ese estado.
type RequestWithStatus = AutomationRequest & { status_kind: "open" | "waiting" | "quote" | "appointment" | "closed" };
type ScheduledJob = { type: JobType; key: string; due: Date };
// Conserva los datos específicos del enlace, el texto del presupuesto o el correo ya preparado.
type JobPayload = {
  completionId?: string;
  token?: string;
  fields?: string[];
  message?: string;
  mail?: MailMessage;
};
// Representa el registro de la cola ya leído de PostgreSQL y listo para ejecutar.
type StoredJob = {
  id: string;
  request_id: string;
  type: JobType;
  dedupe_key: string;
  status: string;
  available_at: Date;
  attempts: number;
  payload: JobPayload;
};

// Las fechas de JavaScript se comparan en milisegundos. El límite incluye el intento inicial.
const minuteMs = 60_000;
const dayMs = 1440 * minuteMs;
const maxAttempts = 4;

// Aplica las preferencias guardadas sobre los valores predeterminados.
function companyRules(company: AutomationCompany): AutomationRules {
  return { ...defaultRules, ...company.rules };
}

// Completa los marcadores de la plantilla y formatea la cita en la zona horaria de la empresa.
function template(
  company: AutomationCompany,
  request: AutomationRequest,
  type: MessageType,
  extra: Record<string, string> = {},
) {
  const goal = company.first_response_minutes;
  const tokens: Record<string, string> = {
    nombre: request.name,
    empresa: company.name,
    solicitud: request.subject,
    plazo: goal % 60 === 0 ? `${goal / 60} h` : `${goal} min`,
    cita: request.appointment_at
      ? new Intl.DateTimeFormat("es-ES", {
        timeZone: company.timezone,
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date(request.appointment_at))
      : "",
    ...extra,
  };
  // Usa la plantilla de la empresa cuando tiene texto y conserva los marcadores desconocidos.
  const source = company.templates[type]?.trim() || defaultTemplates[type];
  let text = source.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token: string) => tokens[token] ?? match);
  // Mantiene el plazo estimado y el enlace aunque la plantilla personalizada omita sus marcadores.
  if (type === "acknowledgement" && !/\{\{\s*plazo\s*\}\}/.test(source)) {
    text += `\n\nPlazo orientativo de respuesta: ${tokens.plazo} dentro del horario laboral.`;
  }
  if (type === "information" && !/\{\{\s*enlace\s*\}\}/.test(source)) text += `\n\n${extra.enlace}`;
  return text;
}

// Comprueba que la solicitud y la configuración pertenecen a la misma empresa antes de escribir en la cola.
function requireSameCompany(company: AutomationCompany, request: NewAutomationRequest) {
  if (company.id !== request.company_id) throw new Error("La solicitud no pertenece a esta empresa.");
}

// Forma una clave estable por regla y solicitud. Una nueva cita o entrada en presupuesto genera otra versión.
function keyFor(type: JobType, requestId: string, version?: Date | string) {
  return version ? `${type}:${requestId}:${new Date(version).toISOString()}` : `${type}:${requestId}`;
}

// Guarda un trabajo en la misma transacción que la solicitud o el cambio que lo originó.
async function enqueue(
  db: PoolClient,
  companyId: string,
  requestId: string,
  job: ScheduledJob,
  payload: JobPayload = {},
  reconcile = false,
) {
  // El formulario público puede insertar trabajos nuevos. La actualización de trabajos existentes se reserva
  // a roles internos.
  // Al reprogramar, conserva la espera de un reintento si su fecha ya está más lejos que la nueva fecha.
  const newDue = `case when jobs.status = 'cancelled' or jobs.attempts = 0
                      then excluded.available_at else greatest(jobs.available_at, excluded.available_at) end`;
  const onConflict = reconcile ? `
    on conflict (company_id, dedupe_key) do update
    set available_at = ${newDue},
        status = case when jobs.status = 'cancelled' then 'pending' else jobs.status end,
        last_error = case when jobs.status = 'cancelled' then null else jobs.last_error end,
        updated_at = now()
    where jobs.status in ('pending', 'cancelled')
      and (jobs.status = 'cancelled' or jobs.available_at is distinct from (${newDue}))` : "";
  // La clave única de la empresa y la regla evita duplicados cuando se vuelve a conciliar la solicitud.
  await db.query(
    `insert into jobs (id, company_id, request_id, type, dedupe_key, available_at, payload)
     values ($1,$2,$3,$4,$5,$6,$7)${onConflict}`,
    [randomUUID(), companyId, requestId, job.type, job.key, job.due, payload],
  );
}

// Encola el acuse inmediato y la alerta diferida al dar de alta una solicitud, según las reglas vigentes.
export async function handleRequestCreated(db: PoolClient, company: AutomationCompany, request: NewAutomationRequest) {
  requireSameCompany(company, request);
  const rules = companyRules(company);
  if (rules.acknowledgement && isValidEmail(request.email)) {
    await enqueue(db, company.id, request.id, {
      type: "acknowledgement", key: keyFor("acknowledgement", request.id), due: new Date(request.created_at),
    });
  }
  // La alerta se programa cuando vence el plazo calculado en minutos de horario laboral.
  const delayDue = computeBusinessDue(request.created_at, company.timezone, company.business_hours, company.first_response_minutes);
  if (rules.delay && delayDue) {
    await enqueue(db, company.id, request.id, { type: "delay", key: keyFor("delay", request.id), due: delayDue });
  }
}

// Recupera el tipo del estado con el identificador de la solicitud y el ámbito de la empresa.
async function statusKind(db: PoolClient, request: AutomationRequest) {
  const result = await db.query<{ kind: RequestWithStatus["status_kind"] }>(
    "select kind from statuses where company_id = $1 and id = $2",
    [request.company_id, request.status_id],
  );
  if (!result.rows[0]) throw new Error("El estado de la solicitud no está disponible.");
  return result.rows[0].kind;
}

// Calcula los trabajos que deberían quedar programados según el estado actual de la solicitud.
function reconcileSchedule(company: AutomationCompany, request: RequestWithStatus): ScheduledJob[] {
  const rules = companyRules(company);
  const schedule: ScheduledJob[] = [];
  if (request.closed_at || request.status_kind === "closed") return schedule;
  if (rules.delay && !request.first_response_at && request.sla_due_at) {
    schedule.push({ type: "delay", key: keyFor("delay", request.id), due: new Date(request.sla_due_at) });
  }
  // El seguimiento se cuenta desde la entrada en presupuesto y el recordatorio desde la fecha confirmada de
  // la cita.
  if (rules.quote && request.status_kind === "quote") {
    schedule.push({
      type: "quote", key: keyFor("quote", request.id, request.state_changed_at),
      due: new Date(new Date(request.state_changed_at).getTime() + rules.quoteDays * dayMs),
    });
  }
  if (rules.appointment && request.appointment_at && isValidEmail(request.email)) {
    schedule.push({
      type: "appointment", key: keyFor("appointment", request.id, request.appointment_at),
      due: new Date(new Date(request.appointment_at).getTime() - rules.appointmentMinutes * minuteMs),
    });
  }
  return schedule;
}

// Sincroniza la cola al editar la solicitud o la configuración que rige sus reglas.
export async function reconcileRequestJobs(db: PoolClient, company: AutomationCompany, request: AutomationRequest) {
  requireSameCompany(company, request);
  const status_kind = await statusKind(db, request);
  const open = !request.closed_at && status_kind !== "closed";
  const rules = companyRules(company);
  // Recalcula el plazo en las solicitudes abiertas sin respuesta y conserva el plazo histórico una vez
  // respondidas o cerradas.
  const slaDue = open && !request.first_response_at
    ? computeBusinessDue(request.created_at, company.timezone, company.business_hours, company.first_response_minutes)
    : request.sla_due_at;
  await db.query(
    `update requests set sla_due_at = $3 where company_id = $1 and id = $2 and sla_due_at is distinct from $3`,
    [company.id, request.id, slaDue],
  );

  // Conserva un envío de presupuesto ya generado si la solicitud y la configuración todavía lo permiten.
  const schedule = reconcileSchedule(company, { ...request, status_kind, sla_due_at: slaDue });
  const keys = schedule.map(({ key }) => key);
  if (open && status_kind === "quote" && rules.quote && rules.quoteAutoSend && isValidEmail(request.email)) {
    keys.push(keyFor("quote_email", request.id, request.state_changed_at));
  }
  // Cancela trabajos pendientes o fallidos que han perdido su condición y elimina sus enlaces y correos
  // preparados.
  await db.query(
    `update jobs set status = 'cancelled', updated_at = now(), payload = payload - 'token' - 'mail'
     where company_id = $1 and request_id = $2 and status in ('pending', 'failed')
       and (not $3::boolean
         or (type = 'acknowledgement' and not $4::boolean)
         or (type = 'information' and not $5::boolean)
         or (type in ('delay', 'quote', 'quote_email', 'appointment') and not (dedupe_key = any($6::text[]))))`,
    [company.id, request.id, open, rules.acknowledgement && isValidEmail(request.email),
      rules.information && isValidEmail(request.email), keys],
  );
  // Añade las reglas que faltan y reprograma las pendientes usando las mismas claves.
  for (const item of schedule) await enqueue(db, company.id, request.id, item, {}, true);
}

// Valida la selección del agente, crea un enlace limitado a esa solicitud y encola su correo.
export async function queueInformationRequest(
  db: PoolClient,
  options: { company: AutomationCompany; request: AutomationRequest; actorId: string; fieldIds: string[] },
) {
  const { company, request, actorId, fieldIds } = options;
  requireSameCompany(company, request);
  if (!companyRules(company).information) throw new Error("La regla de información pendiente está desactivada.");
  if (request.closed_at || await statusKind(db, request) === "closed") throw new Error("La solicitud está cerrada.");
  if (!isValidEmail(request.email)) throw new Error("La solicitud necesita un correo válido.");
  // Elimina repetidos y comprueba todos los identificadores contra el formulario de la propia empresa.
  const selected = [...new Set(fieldIds)];
  if (!selected.length || selected.length > 50) throw new Error("Selecciona los campos pendientes.");
  const fields = await db.query<{ id: string; key: string; label: string }>(
    `select id, key, label from form_fields where company_id = $1 and (id::text = any($2::text[]) or key = any($2::text[]))
     order by position`,
    [company.id, selected],
  );
  if (!selected.every((field) => fields.rows.some(({ key, id }) => field === key || field === id))) {
    throw new Error("Los campos seleccionados no pertenecen al formulario de la empresa.");
  }

  const now = new Date();
  // El prefijo identifica la empresa. La parte aleatoria protege el enlace y su huella permite validarlo sin
  // guardar el texto en la tabla de enlaces.
  const completionId = randomUUID();
  const token = `${company.slug}.${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const keys = fields.rows.map(({ key }) => key);
  const labels = fields.rows.map(({ label }) => label);
  // Registra qué campos se pueden completar y deja el enlace disponible durante siete días.
  await db.query(
    `insert into completions (id, company_id, request_id, token_hash, fields, expires_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [completionId, company.id, request.id, hash, JSON.stringify(keys), new Date(now.getTime() + 7 * dayMs)],
  );
  await enqueue(db, company.id, request.id, {
    // El trabajo usa el identificador del enlace para que su propio envío y sus reintentos compartan clave.
    type: "information", key: keyFor("information", completionId), due: now,
  }, { completionId, token, fields: labels });
  // Deja constancia de la petición del agente y marca la actividad en la bandeja.
  await db.query(
    `insert into events (company_id, request_id, author_id, kind, body, metadata)
     values ($1,$2,$3,'information_requested',$4,$5)`,
    [company.id, request.id, actorId, `Información solicitada: ${labels.join(", ")}.`, { fields: keys }],
  );
  await db.query("update requests set updated_at = now() where company_id = $1 and id = $2", [company.id, request.id]);
}

// Devuelve a pendientes un trabajo fallido que el usuario puede ver en su ámbito de empresa. Conserva el
// recuento de intentos.
export async function retryJob(db: PoolClient, jobId: string) {
  const result = await db.query<{ id: string }>(
    `update jobs set status = 'pending', available_at = now(), updated_at = now()
     where id = $1 and status = 'failed' returning id`,
    [jobId],
  );
  return Boolean(result.rowCount);
}

// Añade la ejecución al historial y actualiza la fecha de actividad sin retroceder respecto a un cambio
// posterior.
async function addEvent(
  db: PoolClient,
  request: AutomationRequest,
  kind: string,
  body: string,
  metadata: Record<string, unknown>,
  now: Date,
) {
  await db.query(
    "insert into events (company_id, request_id, kind, body, metadata, created_at) values ($1,$2,$3,$4,$5,$6)",
    [request.company_id, request.id, kind, body, metadata, now],
  );
  await db.query(
    "update requests set updated_at = greatest(updated_at, $3) where company_id = $1 and id = $2",
    [request.company_id, request.id, now],
  );
}

// Lee y bloquea la solicitud antes de mirar el trabajo. Si otra transacción la está usando, la deja para otro
// intento.
async function loadRequestForJob(db: PoolClient, companyId: string, requestId: string) {
  const { rows } = await db.query<RequestWithStatus>(
    `select r.*, s.kind as status_kind from requests r
     join statuses s on s.company_id = r.company_id and s.id = r.status_id
     where r.company_id = $1 and r.id = $2 for update of r skip locked`,
    [companyId, requestId],
  );
  return rows[0];
}

// Bloquea solo un trabajo pendiente y vencido. Comprueba de nuevo su estado bajo el bloqueo.
async function loadJobForRequest(db: PoolClient, companyId: string, jobId: string, now: Date) {
  const { rows } = await db.query<StoredJob>(
    `select id, request_id, type, dedupe_key, status, available_at, attempts, payload from jobs
     where company_id = $1 and id = $2 and status = 'pending' and available_at <= $3 for update skip locked`,
    [companyId, jobId, now],
  );
  return rows[0];
}

// Revalida la regla justo antes de actuar, cuando el trabajo puede llevar tiempo en la cola.
async function canExecute(
  db: PoolClient, company: AutomationCompany, request: RequestWithStatus, job: StoredJob, now: Date,
) {
  if (request.closed_at || request.status_kind === "closed") return false;
  const rules = companyRules(company);
  switch (job.type) {
    case "acknowledgement":
      return rules.acknowledgement && isValidEmail(request.email);
    case "delay":
      return rules.delay && !request.first_response_at && Boolean(request.sla_due_at);
    // Un enlace usado o caducado ya no da lugar a un aviso.
    case "information": {
      if (!rules.information || !isValidEmail(request.email) || !job.payload.completionId) return false;
      const { rowCount } = await db.query(
        `select 1 from completions where company_id = $1 and request_id = $2 and id = $3
         and used_at is null and expires_at > $4`,
        [company.id, request.id, job.payload.completionId, now],
      );
      return Boolean(rowCount);
    }
    // La clave debe seguir correspondiendo a la entrada en presupuesto o la cita que originó el trabajo.
    case "quote":
    case "quote_email":
      return rules.quote && request.status_kind === "quote"
        && job.dedupe_key === keyFor(job.type, request.id, request.state_changed_at)
        && (job.type !== "quote_email" || (rules.quoteAutoSend && isValidEmail(request.email)));
    case "appointment":
      return rules.appointment && isValidEmail(request.email)
        && Boolean(request.appointment_at && new Date(request.appointment_at) > now)
        && job.dedupe_key === keyFor("appointment", request.id, request.appointment_at ?? undefined);
  }
}

// Busca al agente asignado o, si no lo hay, a un administrador de la empresa.
async function delayRecipient(db: PoolClient, company: AutomationCompany, request: AutomationRequest) {
  const { rows } = await db.query<{ user_id: string; email: string | null }>(
    `select user_id, email from memberships
     where company_id = $1 and (user_id = $2 or ($2::uuid is null and role = 'admin')) order by user_id limit 1`,
    [company.id, request.assigned_to],
  );
  return rows[0];
}

// Registra la alerta en la solicitud incluso cuando el destinatario elegido no tiene un correo válido.
async function delayNotice(
  db: PoolClient, company: AutomationCompany, request: AutomationRequest, job: StoredJob, now: Date,
): Promise<MailMessage | undefined> {
  const recipient = await delayRecipient(db, company, request);
  const text = template(company, request, "delay");
  await addEvent(db, request, "delay_alert", text, { jobId: job.id, recipientId: recipient?.user_id ?? null }, now);
  if (!isValidEmail(recipient?.email)) return undefined;
  return { to: recipient.email, subject: `Primera respuesta vencida · ${company.name}`, text };
}

// Crea el recordatorio interno una sola vez y encola aparte el correo opcional.
async function quoteFollowUp(
  db: PoolClient, company: AutomationCompany, request: AutomationRequest, job: StoredJob, now: Date,
) {
  const text = template(company, request, "quote");
  const { rowCount } = await db.query(
    `insert into follow_ups (company_id, request_id, job_id, assigned_to, message, due_at, created_at)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (job_id) do nothing`,
    [company.id, request.id, job.id, request.assigned_to, text, job.available_at, now],
  );
  if (rowCount) await addEvent(db, request, "follow_up_created", "Seguimiento de presupuesto generado.", { jobId: job.id }, now);
  if (companyRules(company).quoteAutoSend && isValidEmail(request.email)) {
    await enqueue(db, company.id, request.id, {
      type: "quote_email", key: keyFor("quote_email", request.id, request.state_changed_at), due: now,
    }, { message: text }, true);
  }
}

// Distingue el propósito del mensaje antes de añadir al asunto el nombre de la empresa.
const mailSubjects = {
  acknowledgement: "Solicitud recibida",
  information: "Completa tu solicitud",
  quote_email: "Seguimiento de tu presupuesto",
  appointment: "Recordatorio de cita",
};

// Realiza la acción interna de la regla y, cuando corresponda, devuelve el correo listo para enviar.
async function prepareMail(
  db: PoolClient, company: AutomationCompany, request: RequestWithStatus, job: StoredJob, now: Date,
): Promise<MailMessage | undefined> {
  if (job.type === "delay") return delayNotice(db, company, request, job, now);
  if (job.type === "quote") {
    await quoteFollowUp(db, company, request, job, now);
    return undefined;
  }
  if (!isValidEmail(request.email)) return undefined;
  // Si faltan datos, construye el enlace público y enumera los campos seleccionados.
  const extra: Record<string, string> = job.type === "information" ? {
    enlace: applicationUrl(`/completar/${encodeURIComponent(job.payload.token ?? "")}`),
    campos: (job.payload.fields ?? []).join(", "),
  } : {};
  const type = job.type === "quote_email" ? "quote" : job.type;
  return {
    to: request.email,
    subject: `${mailSubjects[job.type]} · ${company.name}`,
    text: job.payload.message ?? template(company, request, type, extra),
  };
}

// Cada fase informa un resultado que el ejecutor puede contar o usar para iniciar el envío.
type JobOutcome = "completed" | "cancelled" | "failed" | "retrying" | "prepared" | "skipped";

// Cierra un trabajo, registra su hora y borra el enlace y el cuerpo guardados temporalmente.
async function finishJob(
  db: PoolClient, companyId: string, job: StoredJob, status: "completed" | "cancelled", now: Date,
): Promise<JobOutcome> {
  await db.query(
    `update jobs set status = $3, executed_at = $4, updated_at = $4, last_error = null,
        attempts = attempts + case when $3 = 'completed' then 1 else 0 end,
        payload = payload - 'token' - 'mail'
     where company_id = $1 and id = $2`,
    [companyId, job.id, status, now],
  );
  return status;
}

// Registra el intento fallido y programa esperas de uno, dos y cuatro minutos antes del estado fallido
// definitivo.
async function recordFailure(
  db: PoolClient, request: RequestWithStatus, job: StoredJob, error: unknown, now: Date,
): Promise<JobOutcome> {
  const attempts = job.attempts + 1;
  const retrying = attempts < maxAttempts;
  const reason = error instanceof Error ? error.message.slice(0, 300) : "Error al ejecutar la regla.";
  const status = retrying ? "pending" : "failed";
  const again = retrying ? new Date(now.getTime() + 2 ** (attempts - 1) * minuteMs) : now;
  await db.query(
    `update jobs set status = $3, attempts = $4, available_at = $5, last_error = $6, executed_at = $7, updated_at = $7
     where company_id = $1 and id = $2`,
    [request.company_id, job.id, status, attempts, again, reason, now],
  );
  // El historial conserva cada fallo por separado aunque la cola solo guarde el último error.
  await addEvent(db, request, "automation_failed", reason, { jobId: job.id, type: job.type, attempt: attempts }, now);
  return retrying ? "retrying" : "failed";
}

// Ejecuta la preparación o el envío en una transacción independiente con acceso limitado a una empresa.
async function runJobPhase(
  companyId: string, candidate: { id: string; request_id: string }, now: Date, deliver: boolean,
): Promise<JobOutcome> {
  return withWorkerCompany(companyId, async (db) => {
    // Bloquea primero la solicitud, igual que al editarla. Así el envío y la cancelación no pueden avanzar a
    // la vez.
    const request = await loadRequestForJob(db, companyId, candidate.request_id);
    if (!request) return "skipped";
    const job = await loadJobForRequest(db, companyId, candidate.id, now);
    if (!job) return "skipped";
    const { rows } = await db.query<AutomationCompany>("select * from companies where id = $1", [companyId]);
    const company = rows[0];
    if (!company || !await canExecute(db, company, request, job, now)) return finishJob(db, companyId, job, "cancelled", now);
    // Si cambió el plazo desde que se leyó la cola, aplaza el trabajo hasta la nueva fecha.
    const scheduled = reconcileSchedule(company, request).find(({ key }) => key === job.dedupe_key);
    if (scheduled && scheduled.due > now) {
      await db.query("update jobs set available_at = $3, updated_at = $4 where company_id = $1 and id = $2",
        [companyId, job.id, scheduled.due, now]);
      return "skipped";
    }
    if (!deliver && job.payload.mail) return "prepared";

    // El punto de guardado permite deshacer el intento y registrar el fallo dentro de la misma transacción.
    await db.query("savepoint automation_attempt");
    try {
      // En la segunda fase reutiliza el contenido persistido y una clave estable para el proveedor.
      if (deliver && job.payload.mail) {
        let message = job.payload.mail;
        let idempotencyKey = `request-job/${job.id}`;
        let recipientId: string | undefined;
        if (job.type === "delay") {
          const recipient = await delayRecipient(db, company, request);
          if (!isValidEmail(recipient?.email)) return finishJob(db, companyId, job, "completed", now);
          // Revisa si cambió el agente. Cada destinatario conserva su propia clave para los reintentos.
          recipientId = recipient.user_id;
          message = { ...message, to: recipient.email };
          idempotencyKey += `/${createHash("sha256").update(message.to).digest("hex").slice(0, 24)}`;
        }
        // Cancela la copia preparada si cambió la dirección del cliente para evitar entregar el enlace a la
        // dirección anterior.
        if (job.type !== "delay" && message.to !== request.email) {
          return finishJob(db, companyId, job, "cancelled", now);
        }
        const mode = await deliverMail(message, idempotencyKey);
        // Mantiene el contenido del correo simulado visible y registra el envío real de un enlace sin exponer
        // el enlace en el historial.
        const body = job.type === "information" && mode === "resend"
          ? "Se ha enviado el enlace para completar los datos pendientes."
          : message.text;
        await addEvent(db, request, mode === "development" ? "email_simulated" : "email_sent", body,
          { jobId: job.id, type: job.type, to: message.to, subject: message.subject, recipientId }, now);
        return finishJob(db, companyId, job, "completed", now);
      }
      if (deliver) return "skipped";
      const message = await prepareMail(db, company, request, job, now);
      if (!message) return finishJob(db, companyId, job, "completed", now);
      // Guarda el contenido antes de contactar con el proveedor para reutilizarlo si el resultado es incierto
      // o el proceso se reinicia.
      await db.query(
        `update jobs set payload = jsonb_set(payload, '{mail}', $3::jsonb), updated_at = $4 where company_id = $1 and id = $2`,
        [companyId, job.id, message, now],
      );
      return "prepared";
    } catch (error) {
      await db.query("rollback to savepoint automation_attempt");
      // Los errores de PostgreSQL pueden incluir datos de las filas. Sustituye esos mensajes antes de
      // mostrarlos en el historial.
      const safeError = error && typeof error === "object" && "code" in error
        ? new Error("No se pudo guardar la ejecución de la regla.") : error;
      return recordFailure(db, request, job, safeError, now);
    }
  });
}

// Procesa un lote de trabajos vencidos y devuelve el número de ejecuciones por resultado.
export async function runJobs(options: { now?: Date; limit?: number; companyId?: string } = {}) {
  const startedAt = Date.now();
  // Permite fijar el reloj en las pruebas y acota el número de trabajos por pasada.
  const clock = () => options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  // Lee la lista de empresas y abre consultas de cola separadas para respetar su aislamiento.
  const companyIds = await listWorkerCompanyIds();
  const companies = options.companyId ? companyIds.filter((id) => id === options.companyId) : companyIds;
  const result = { attempted: 0, completed: 0, cancelled: 0, failed: 0, retrying: 0, skipped: 0 };
  // Los trabajos ya examinados pasan a otra llamada si permanecen pendientes. El tiempo límite acota la
  // ejecución.
  const seen = new Set<string>();
  for (const companyId of companies) {
    while (result.attempted < limit && Date.now() - startedAt < 40_000) {
      // Lee primero los candidatos más antiguos. Cada fase vuelve a comprobarlos con bloqueo.
      const jobs = await withWorkerCompany(companyId, async (db) => {
        const resultSet = await db.query<{ id: string; request_id: string }>(
          `select id, request_id from jobs where company_id = $1 and status = 'pending' and available_at <= $2
            and not (id = any($3::uuid[])) order by available_at, id limit $4`,
          [companyId, clock(), [...seen], limit - result.attempted],
        );
        return resultSet.rows;
      });
      if (!jobs.length) break;
      for (const job of jobs) {
        if (Date.now() - startedAt >= 40_000) break;
        seen.add(job.id);
        result.attempted += 1;
        // La primera transacción confirma la preparación antes de abrir la transacción que hará el envío.
        const prepared = await runJobPhase(companyId, job, clock(), false);
        const outcome = prepared === "prepared" ? await runJobPhase(companyId, job, clock(), true) : prepared;
        if (outcome !== "prepared") result[outcome] += 1;
      }
    }
    if (result.attempted >= limit || Date.now() - startedAt >= 40_000) break;
  }
  return result;
}
