import type { PoolClient } from "pg";
import {
  defaultBusinessHours,
  defaultRules,
  defaultTemplates,
  type AutomationRules,
  type BusinessHours,
  type MessageTemplates,
} from "./automation";

// Claves de sector que usa el asistente de alta y guarda la empresa.
export type PresetKey = "salon" | "workshop" | "renovation" | "custom";

// El formulario guarda las respuestas por clave aunque se edite la etiqueta.
type PresetField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "date";
  required: boolean;
  options?: string[];
};

// El tipo de estado determina la lógica del flujo y el texto permite personalizar su presentación.
export type PresetStatus = {
  name: string;
  kind: "open" | "waiting" | "quote" | "appointment" | "closed";
  color: string;
};

// Las reglas y los mensajes sectoriales pueden sobrescribir solo parte de sus valores predeterminados.
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

// Estados que varias plantillas reutilizan con el mismo nombre y color inicial.
const newStatus: PresetStatus = { name: "Nueva", kind: "open", color: "#4773b2" };
const waitingStatus: PresetStatus = { name: "Pendiente de datos", kind: "waiting", color: "#ac7242" };
const quoteStatus: PresetStatus = { name: "Presupuesto enviado", kind: "quote", color: "#805ea6" };
const appointmentStatus: PresetStatus = { name: "Cita confirmada", kind: "appointment", color: "#3a8e73" };
const closedStatus: PresetStatus = { name: "Cerrada", kind: "closed", color: "#696e79" };

// El orden de las listas se conserva al crear el formulario y el flujo de la empresa.
export const presets: Record<PresetKey, Preset> = {
  // La peluquería coordina citas y pide disponibilidad desde el formulario.
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
  // El taller recoge datos del vehículo y hace seguimiento de presupuestos.
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
  // Las reformas coordinan una visita antes de preparar el presupuesto.
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
  // Configuración inicial editable para un sector sin plantilla específica.
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

/** Copia la plantilla al crear la empresa para que después pueda editar su configuración. */
export async function applyPreset(client: PoolClient, companyId: string, presetKey: PresetKey) {
  const preset = presets[presetKey];
  // Las excepciones de la plantilla prevalecen sobre las reglas y mensajes comunes.
  await client.query(
    `UPDATE companies
     SET industry = $2, primary_color = $3, business_hours = $4,
       first_response_minutes = $5, rules = $6, templates = $7
     WHERE id = $1`,
    [companyId, presetKey, preset.color, preset.businessHours, preset.firstResponseMinutes,
      { ...defaultRules, ...preset.rules }, { ...defaultTemplates, ...preset.templates }],
  );
  // La posición de cada servicio coincide con su orden en el formulario.
  for (const [position, service] of preset.services.entries()) {
    await client.query(
      "INSERT INTO services (company_id, name, position) VALUES ($1, $2, $3)",
      [companyId, service, position],
    );
  }
  // Cada campo guarda su clave, presentación, validación y opciones en una fila propia.
  for (const [position, field] of preset.fields.entries()) {
    await client.query(
      `INSERT INTO form_fields (company_id, key, label, type, required, options, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, field.key, field.label, field.type, field.required, JSON.stringify(field.options ?? []), position],
    );
  }
  // El estado se crea para esta empresa y recibe un identificador propio.
  for (const [position, status] of preset.statuses.entries()) {
    await client.query(
      "INSERT INTO statuses (company_id, name, kind, color, position) VALUES ($1, $2, $3, $4, $5)",
      [companyId, status.name, status.kind, status.color, position],
    );
  }
}
