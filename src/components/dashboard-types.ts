// Comparte los tipos de campo con el formulario público para mantener las mismas opciones en el editor.
import type { FieldType } from '../lib/public-types';

// Estas claves representan roles, plantillas, automatizaciones y estados del dominio en la API del panel.
export type DashboardRole = 'admin' | 'employee';
export type Industry = 'salon' | 'workshop' | 'renovation' | 'custom';
export type RuleKey = 'acknowledgment' | 'sla' | 'information' | 'quoteFollowup' | 'appointmentReminder';
export type RequestPriority = 'low' | 'normal' | 'high';
export type RequestOutcome = 'won' | 'lost';
export type StatusKind = 'open' | 'waiting' | 'quote' | 'appointment' | 'closed';

// Define un campo configurable. La lista de opciones se usa para los campos desplegables.
export interface DashboardField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

// Combina la presentación de un estado con el tipo que utiliza el motor de solicitudes.
export interface DashboardStatus {
  id: string;
  label: string;
  color: string;
  kind: StatusKind;
}

// Reúne la configuración editable y el rol que tiene la cuenta actual en esta empresa.
export interface DashboardCompany {
  id: string;
  slug: string;
  name: string;
  industry: Industry;
  role: DashboardRole;
  logoUrl: string;
  color: string;
  timezone: string;
  // El horario usa días numerados desde el domingo y horas locales en la zona de la empresa.
  businessHours: { weekdays: number[]; start: string; end: string };
  // El orden de servicios, campos y estados corresponde al que se presenta en los selectores.
  services: string[];
  fields: DashboardField[];
  statuses: DashboardStatus[];
  // Las reglas comparten activación y plantilla. Cada una admite los parámetros que necesita.
  rules: Record<RuleKey, { enabled: boolean; template: string; delay?: number; automatic?: boolean }>;
}

// Representa a un integrante que puede asignarse como responsable dentro de la empresa.
export interface DashboardMember {
  id: string;
  name: string;
  email: string;
  role: DashboardRole;
}

// Cada entrada del historial identifica la acción, su autor y el instante en que se registró.
export interface DashboardEvent {
  id: string;
  kind: string;
  text: string;
  actor: string;
  at: string;
}

// Proyección que se usa tanto en la bandeja como en el panel lateral de detalle.
export interface DashboardRequest {
  id: string;
  name: string;
  email: string;
  phone: string;
  service: string;
  subject: string;
  origin: string;
  // El estado y la asignación referencian las listas de estados y miembros de la empresa.
  status: string;
  priority: RequestPriority;
  assigneeId: string | null;
  // Las fechas se reciben como cadenas y el valor nulo indica que el hito aún no se produjo o no se programó.
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  slaDueAt: string | null;
  followupAt: string | null;
  appointmentAt: string | null;
  nextAction: string | null;
  // El cierre aporta un resultado y puede incluir el importe si se consiguió o el motivo si se perdió.
  closedAt: string | null;
  outcome: RequestOutcome | null;
  amount: number | null;
  lostReason: string | null;
  // Las respuestas adicionales se indexan por identificador de campo. El historial y las tareas se incluyen por solicitud.
  data: Record<string, string>;
  events: DashboardEvent[];
  followups: { id: string; createdAt: string; completedAt: string | null; message?: string; dueAt?: string | null; assignedTo?: string | null; }[];
}

// Describe una ejecución programada y conserva el número de intentos y el error para su revisión.
export interface DashboardJob {
  id: string;
  requestId: string;
  kind: RuleKey;
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled';
  runAt: string;
  attempts: number;
  error: string | null;
}

// La respuesta del espacio de trabajo distingue las empresas disponibles del contexto seleccionado y su modo de correo.
export interface DashboardData {
  viewer: { id: string; name: string; email: string };
  companies: Pick<DashboardCompany, 'id' | 'slug' | 'name' | 'role' | 'industry'>[];
  company: DashboardCompany | null;
  members: DashboardMember[];
  requests: DashboardRequest[];
  jobs: DashboardJob[];
  mode: 'demo' | 'live';
  mailMode: 'simulated' | 'live';
}

// La propiedad action distingue el cuerpo de cada operación que recibe la API.
export type DashboardAction =
  | { action: 'createCompany'; name: string; industry: Industry }
  | { action: 'createRequest'; name: string; email: string; phone: string; service: string; origin: string; priority: RequestPriority; data: Record<string,string> }
  // Omitir una propiedad conserva su valor. Los campos que admiten null pueden vaciarse.
  | { action: 'updateRequest'; requestId: string; status?: string; priority?: RequestPriority; assigneeId?: string | null; followupAt?: string | null; appointmentAt?: string | null; nextAction?: string | null; outcome?: RequestOutcome; amount?: number | null; lostReason?: string | null }
  | { action: 'addEvent'; requestId: string; kind: 'note' | 'contact' | 'completeFollowup'; text: string; followupId?: string }
  | { action: 'requestInfo'; requestId: string; fields: string[] }
  | { action: 'updateCompany'; settings: Pick<DashboardCompany, 'name' | 'logoUrl' | 'color' | 'timezone' | 'businessHours' | 'services' | 'fields' | 'statuses' | 'rules'> }
  | { action: 'deleteRequest'; requestId: string }
  | { action: 'retryJob'; jobId: string }
  | { action: 'addMember'; email: string; role: DashboardRole };
