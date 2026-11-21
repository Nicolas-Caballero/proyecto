import type { PoolClient } from "pg";
import {
  defaultBusinessHours,
  defaultRules,
  defaultTemplates,
  type AutomationRules,
  type BusinessHours,
  type MessageTemplates,
} from "./automation";

export type PresetKey = "salon" | "workshop" | "renovation" | "custom";

type PresetField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "date";
  required: boolean;
  options?: string[];
};

export type PresetStatus = {
  name: string;
  kind: "open" | "waiting" | "quote" | "appointment" | "closed";
  color: string;
};

type Preset = {
  label: string;
  color: string;
  businessHours: BusinessHours;
  firstResponseMinutes: number;
  services: string[];
  fields: PresetField[];
  statuses: PresetStatus[];
  rules: Partial<AutomationRules>;
  templates: Partial<MessageTemplates>;
};

const newStatus: PresetStatus = { name: "Nueva", kind: "open", color: "#4773b2" };
const waitingStatus: PresetStatus = { name: "Pendiente de datos", kind: "waiting", color: "#ac7242" };
const quoteStatus: PresetStatus = { name: "Presupuesto enviado", kind: "quote", color: "#805ea6" };
const appointmentStatus: PresetStatus = { name: "Cita confirmada", kind: "appointment", color: "#3a8e73" };
const closedStatus: PresetStatus = { name: "Cerrada", kind: "closed", color: "#696e79" };

export const presets: Record<PresetKey, Preset> = {
  salon: {
    label: "Peluquería",
    color: "#a15152",
    businessHours: { days: [2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
    firstResponseMinutes: 90,
    services: ["Corte y peinado", "Coloración", "Mechas y balayage", "Tratamiento capilar"],
    fields: [
      { key: "disponibilidad", label: "Disponibilidad", type: "text", required: true },
      { key: "comentarios", label: "Comentarios", type: "textarea", required: false },
    ],
    statuses: [newStatus, waitingStatus, appointmentStatus, closedStatus],
    rules: { quote: false, appointmentMinutes: 1440 },
    templates: {
      acknowledgement: "Hola {{nombre}}, hemos recibido tu solicitud para {{solicitud}}. Confirmaremos contigo una cita en aproximadamente {{plazo}} dentro de nuestro horario laboral. Gracias, {{empresa}}.",
    },
  },
  workshop: {
    label: "Taller",
    color: "#406780",
    businessHours: { days: [1, 2, 3, 4, 5], start: "08:30", end: "18:00" },
    firstResponseMinutes: 120,
    services: ["Revisión y mantenimiento", "Diagnóstico de avería", "Neumáticos", "Frenos"],
    fields: [
      { key: "vehiculo", label: "Vehículo", type: "text", required: true },
      { key: "problema", label: "Problema del vehículo", type: "textarea", required: true },
      { key: "matricula", label: "Matrícula", type: "text", required: false },
    ],
    statuses: [newStatus, waitingStatus, quoteStatus, appointmentStatus, closedStatus],
    rules: { quoteDays: 2, appointmentMinutes: 720 },
    templates: {
      quote: "Hola {{nombre}}, ¿has podido revisar el presupuesto del taller para {{solicitud}}? Si quieres confirmarlo o tienes alguna duda, responde a este correo. Gracias, {{empresa}}.",
    },
  },
  renovation: {
    label: "Reformas",
    color: "#866247",
    businessHours: defaultBusinessHours,
    firstResponseMinutes: 240,
    services: ["Reforma integral", "Cocina", "Baño", "Pintura y acabados"],
    fields: [
      { key: "localidad", label: "Localidad", type: "text", required: true },
      { key: "disponibilidad", label: "Disponibilidad para una visita", type: "text", required: true },
      { key: "descripcion", label: "Descripción de los trabajos", type: "textarea", required: true },
    ],
    statuses: [
      newStatus,
      waitingStatus,
      { ...appointmentStatus, name: "Visita concertada" },
      quoteStatus,
      closedStatus,
    ],
    rules: { quoteDays: 5, appointmentMinutes: 1440 },
    templates: {
      appointment: "Hola {{nombre}}, te recordamos la visita de {{empresa}} el {{cita}}. Avísanos si necesitas cambiarla.",
    },
  },
  custom: {
    label: "Otro sector",
    color: "#477464",
    businessHours: defaultBusinessHours,
    firstResponseMinutes: 120,
    services: ["Consulta general"],
    fields: [{ key: "detalles", label: "Cuéntanos qué necesitas", type: "textarea", required: true }],
    statuses: [newStatus, waitingStatus, quoteStatus, appointmentStatus, closedStatus],
    rules: {},
    templates: {},
  },
};

/** Copies a preset once into a newly created company's editable configuration. */
export async function applyPreset(client: PoolClient, companyId: string, presetKey: PresetKey) {
  const preset = presets[presetKey];
  await client.query(
    `UPDATE companies
     SET industry = $2, primary_color = $3, business_hours = $4,
       first_response_minutes = $5, rules = $6, templates = $7
     WHERE id = $1`,
    [companyId, presetKey, preset.color, preset.businessHours, preset.firstResponseMinutes,
      { ...defaultRules, ...preset.rules }, { ...defaultTemplates, ...preset.templates }],
  );
  for (const [position, service] of preset.services.entries()) {
    await client.query(
      "INSERT INTO services (company_id, name, position) VALUES ($1, $2, $3)",
      [companyId, service, position],
    );
  }
  for (const [position, field] of preset.fields.entries()) {
    await client.query(
      `INSERT INTO form_fields (company_id, key, label, type, required, options, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, field.key, field.label, field.type, field.required, JSON.stringify(field.options ?? []), position],
    );
  }
  for (const [position, status] of preset.statuses.entries()) {
    await client.query(
      "INSERT INTO statuses (company_id, name, kind, color, position) VALUES ($1, $2, $3, $4, $5)",
      [companyId, status.name, status.kind, status.color, position],
    );
  }
}
