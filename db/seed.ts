// Permite ejecutar la semilla desde la consola con la configuración local.
import "./env";
import type { PoolClient } from "pg";
import { reconcileRequestJobs, type AutomationCompany, type AutomationRequest } from "../src/lib/automation";
import { computeBusinessDue } from "../src/lib/business-time";
import { closeDb, transaction, type CompanyRole } from "../src/lib/db";
import { applyPreset, type PresetKey, type PresetStatus } from "../src/lib/presets";

// Los identificadores coinciden con las cuentas ficticias de inicio de sesión.
const marta = "00000000-0000-4000-8000-000000000001";
const lucia = "00000000-0000-4000-8000-000000000002";
const diego = "00000000-0000-4000-8000-000000000003";
const hoursMs = 60 * 60 * 1000;
// Todas las fechas se calculan a partir del mismo instante.
const now = Date.now();

// La semilla especifica servicios por posición y estados por tipo para resolver sus UUID al insertar.
type DemoRequest = {
  name: string;
  status: PresetStatus["kind"];
  priority?: "low" | "normal" | "high";
  source: string;
  service: number;
  assignedTo?: string;
  ageHours: number;
  responseMinutes?: number;
  appointmentHours?: number;
  action?: { text: string; hours: number };
  outcome?: "won" | "lost";
  amount?: number;
  lossReason?: string;
  followedUp?: boolean;
  answers: Record<string, string>;
};

// Describe una empresa demo, sus miembros y el historial inicial de solicitudes.
type DemoCompany = {
  id: string;
  slug: string;
  name: string;
  preset: PresetKey;
  members: { id: string; name: string; email: string; role: CompanyRole }[];
  requests: DemoRequest[];
};

// Marta puede alternar entre las dos empresas. Las otras cuentas muestran accesos a una sola.
const martaUser = { id: marta, name: "Marta Ruiz", email: "marta@pulso.demo", role: "admin" as const };
const companies: DemoCompany[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    slug: "estudio-norte",
    name: "Estudio Norte",
    preset: "salon",
    members: [martaUser, { id: lucia, name: "Lucía Morales", email: "lucia@pulso.demo", role: "employee" }],
    // La peluquería incluye altas recientes, citas, casos vencidos y cierres con distintos resultados.
    requests: [
      { name: "Alba Martín", status: "open", priority: "high", source: "instagram", service: 2, ageHours: 68, answers: { disponibilidad: "Esta semana por la tarde", comentarios: "Quiero aclarar un poco las puntas." } },
      { name: "Clara Jiménez", status: "open", source: "web", service: 0, assignedTo: lucia, ageHours: 45, answers: { disponibilidad: "Después de las 16:30" } },
      { name: "Sofía Navarro", status: "waiting", source: "whatsapp", service: 1, assignedTo: marta, ageHours: 95, responseMinutes: 38, action: { text: "Confirmar el tono con la clienta", hours: -5 }, answers: { disponibilidad: "Sábado por la mañana", comentarios: "Busco un castaño cálido." } },
      { name: "Diego Romero", status: "appointment", source: "google", service: 0, assignedTo: lucia, ageHours: 43, responseMinutes: 21, appointmentHours: 37, answers: { disponibilidad: "Por la mañana" } },
      { name: "Marta Iglesias", status: "open", priority: "low", source: "telefono", service: 3, ageHours: 6, answers: { disponibilidad: "El próximo jueves" } },
      { name: "Inés Vidal", status: "closed", source: "instagram", service: 2, assignedTo: marta, ageHours: 154, responseMinutes: 94, outcome: "won", amount: 85, followedUp: true, answers: { disponibilidad: "Horario flexible" } },
      { name: "Noa Serrano", status: "closed", source: "web", service: 1, assignedTo: lucia, ageHours: 183, responseMinutes: 127, outcome: "won", amount: 58, answers: { disponibilidad: "A primera hora" } },
      { name: "Vera Ortega", status: "closed", source: "google", service: 0, assignedTo: lucia, ageHours: 211, responseMinutes: 61, outcome: "lost", lossReason: "No coincidió el horario", answers: { disponibilidad: "Solo el lunes" } },
    ],
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    slug: "motor-barrio",
    name: "Motor Barrio",
    preset: "workshop",
    members: [{ id: diego, name: "Diego Ramos", email: "diego@pulso.demo", role: "admin" }, martaUser],
    // El taller permite demostrar un presupuesto pendiente y un caso ganado tras un seguimiento.
    requests: [
      { name: "Samuel Pérez", status: "quote", priority: "high", source: "google", service: 3, assignedTo: diego, ageHours: 109, responseMinutes: 51, answers: { vehiculo: "Seat León", problema: "Vibración al frenar", matricula: "0000 AAA" } },
      { name: "Laura Molina", status: "waiting", source: "web", service: 1, assignedTo: diego, ageHours: 70, responseMinutes: 29, action: { text: "Pedir el año del vehículo", hours: 8 }, answers: { vehiculo: "Renault Clio", problema: "Testigo del motor encendido" } },
      { name: "Rubén Torres", status: "open", source: "whatsapp", service: 2, ageHours: 77, answers: { vehiculo: "Citroën C3", problema: "Desgaste en la rueda trasera" } },
      { name: "Daniel Castro", status: "appointment", source: "telefono", service: 0, assignedTo: diego, ageHours: 82, responseMinutes: 72, appointmentHours: 18, answers: { vehiculo: "Toyota Yaris", problema: "Revisión de 60.000 km" } },
      { name: "Elena Blanco", status: "closed", source: "google", service: 0, assignedTo: diego, ageHours: 270, responseMinutes: 70, outcome: "won", amount: 250, followedUp: true, answers: { vehiculo: "Peugeot 208", problema: "Cambio de aceite y filtros" } },
    ],
  },
];

/** Convierte un desplazamiento firmado de horas en una fecha de demostración. */
function fromNow(hours: number) {
  return new Date(now + hours * hoursMs);
}

/** Persiste una solicitud ficticia y reconstruye su actividad y automatizaciones. */
async function insertRequest(
  db: PoolClient,
  company: AutomationCompany,
  request: DemoRequest,
  service: { id: string; name: string },
  statusId: string,
  index: number,
) {
  // Calcula las fechas de actividad y el vencimiento con el horario de la empresa.
  const createdAt = fromNow(-request.ageHours);
  const responseAt = request.responseMinutes == null ? null : new Date(createdAt.getTime() + request.responseMinutes * 60_000);
  const stateChangedAt = request.status === "open" ? createdAt : new Date(createdAt.getTime() + 5 * hoursMs);
  const closedAt = request.outcome ? new Date(createdAt.getTime() + 84 * hoursMs) : null;
  const updatedAt = closedAt ?? (request.status === "open" ? responseAt ?? createdAt : stateChangedAt);
  const appointmentAt = request.appointmentHours ? fromNow(request.appointmentHours) : null;
  const slaDueAt = computeBusinessDue(createdAt, company.timezone, company.business_hours, company.first_response_minutes);
  // Normaliza el nombre para generar un correo bajo un dominio reservado para pruebas.
  const emailName = request.name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replaceAll(" ", ".");
  const { rows: [inserted] } = await db.query<AutomationRequest>(
    `INSERT INTO requests (
       company_id, status_id, service_id, assigned_to, name, email, phone, subject, answers,
       priority, source, next_action, next_action_at, first_response_at, sla_due_at, state_changed_at,
       appointment_at, outcome, confirmed_amount, loss_reason, closed_at, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
     ) RETURNING *`,
    [
      company.id, statusId, service.id, request.assignedTo ?? null, request.name, `${emailName}@ejemplo.test`,
      `+340000000${String(index + 1).padStart(2, "0")}`, service.name, request.answers, request.priority ?? "normal",
      request.source, request.action?.text ?? null, request.action ? fromNow(request.action.hours) : null,
      responseAt, slaDueAt, stateChangedAt, appointmentAt, request.outcome ?? null,
      request.amount ?? null, request.lossReason ?? null, closedAt, createdAt, updatedAt,
    ],
  );

  // La línea temporal empieza con la recepción y añade un contacto cuando consta una respuesta.
  await db.query(
    `INSERT INTO events (company_id, request_id, kind, body, created_at)
     VALUES ($1,$2,'created',$3,$4)`,
    [company.id, inserted.id, "Solicitud recibida.", createdAt],
  );
  if (responseAt) {
    await db.query(
      `INSERT INTO events (company_id, request_id, author_id, kind, body, created_at)
       VALUES ($1,$2,$3,'contact',$4,$5)`,
      [company.id, inserted.id, request.assignedTo ?? null, "Primer contacto registrado con el cliente.", responseAt],
    );
  }
  // Algunos casos incluyen un seguimiento completado antes del cierre para probar la métrica.
  if (request.followedUp) {
    await db.query(
      `INSERT INTO follow_ups (company_id, request_id, assigned_to, message, due_at, completed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [company.id, inserted.id, request.assignedTo, "Consultar si necesita ayuda para confirmar.",
        new Date(createdAt.getTime() + 55 * hoursMs), new Date(createdAt.getTime() + 56 * hoursMs),
        new Date(createdAt.getTime() + 48 * hoursMs)],
    );
  }
  // Los cierres reciben su evento histórico. Las solicitudes abiertas programan los trabajos aplicables.
  if (closedAt) {
    await db.query(
      `INSERT INTO events (company_id, request_id, author_id, kind, body, created_at)
       VALUES ($1,$2,$3,'closed',$4,$5)`,
      [company.id, inserted.id, request.assignedTo ?? null,
        request.outcome === "won" ? "Solicitud conseguida." : "Solicitud perdida.", closedAt],
    );
  }
  if (!closedAt) await reconcileRequestJobs(db, company, inserted);
}

/** Crea una empresa demo completa y devuelve si añadió datos. */
async function seedCompany(db: PoolClient, company: DemoCompany) {
  // Un identificador existente indica que la empresa ya se cargó.
  const inserted = await db.query(
    "INSERT INTO companies(id, slug, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
    [company.id, company.slug, company.name],
  );
  if (!inserted.rowCount) return false;
  await applyPreset(db, company.id, company.preset);
  // Las claves foráneas de los responsables requieren que los miembros existan primero.
  for (const { id, name, email, role } of company.members) {
    await db.query(
      "INSERT INTO memberships(company_id, user_id, name, email, role) VALUES ($1,$2,$3,$4,$5)",
      [company.id, id, name, email, role],
    );
  }
  // Recupera los identificadores que generó PostgreSQL al copiar la plantilla.
  const { rows: [configured] } = await db.query<AutomationCompany>("SELECT * FROM companies WHERE id = $1", [company.id]);
  const { rows: services } = await db.query<{ id: string; name: string }>(
    "SELECT id,name FROM services WHERE company_id = $1 ORDER BY position", [company.id],
  );
  const { rows: statuses } = await db.query<{ id: string; kind: PresetStatus["kind"] }>(
    "SELECT id,kind FROM statuses WHERE company_id = $1", [company.id],
  );
  const statusIds = new Map(statuses.map(({ id, kind }) => [kind, id]));
  for (const [index, request] of company.requests.entries()) {
    const statusId = statusIds.get(request.status);
    if (!statusId) throw new Error(`Falta el estado de demostración ${request.status}.`);
    await insertRequest(db, configured, request, services[request.service], statusId, index);
  }
  return true;
}

/** Carga ambas empresas ficticias en una sola transacción y resume el resultado. */
async function seed() {
  // La semilla requiere un entorno que admita la demo y el correo simulado.
  if (process.env.DEMO_MODE === "false" || process.env.MAIL_MODE === "resend") {
    throw new Error("Usa una base de demostración y el modo de correo simulado para cargar los datos ficticios.");
  }
  const loaded = await transaction(async (db) => {
    const names: string[] = [];
    for (const company of companies) {
      if (await seedCompany(db, company)) names.push(company.name);
    }
    return names;
  });
  console.log(loaded.length ? `Datos de demostración cargados: ${loaded.join(", ")}.` : "Los datos de demostración ya están cargados.");
}

// Comunica los fallos al proceso que llamó al script y libera las conexiones.
seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
