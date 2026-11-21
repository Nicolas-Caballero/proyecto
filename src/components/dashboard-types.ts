import type { FieldType } from '../lib/public-types';

export type DashboardRole = 'admin' | 'employee';
export type Industry = 'salon' | 'workshop' | 'renovation' | 'custom';
export type RuleKey = 'acknowledgment' | 'sla' | 'information' | 'quoteFollowup' | 'appointmentReminder';
export type RequestPriority = 'low' | 'normal' | 'high';
export type RequestOutcome = 'won' | 'lost';
export type StatusKind = 'open' | 'waiting' | 'quote' | 'appointment' | 'closed';

export interface DashboardField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface DashboardStatus {
  id: string;
  label: string;
  color: string;
  kind: StatusKind;
}

export interface DashboardCompany {
  id: string;
  slug: string;
  name: string;
  industry: Industry;
  role: DashboardRole;
  logoUrl: string;
  color: string;
  timezone: string;
  businessHours: { weekdays: number[]; start: string; end: string };
  services: string[];
  fields: DashboardField[];
  statuses: DashboardStatus[];
  rules: Record<RuleKey, { enabled: boolean; template: string; delay?: number; automatic?: boolean }>;
}

export interface DashboardMember {
  id: string;
  name: string;
  email: string;
  role: DashboardRole;
}

export interface DashboardEvent {
  id: string;
  kind: string;
  text: string;
  actor: string;
  at: string;
}

export interface DashboardRequest {
  id: string;
  name: string;
  email: string;
  phone: string;
  service: string;
  subject: string;
  origin: string;
  status: string;
  priority: RequestPriority;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  slaDueAt: string | null;
  followupAt: string | null;
  appointmentAt: string | null;
  nextAction: string | null;
  closedAt: string | null;
  outcome: RequestOutcome | null;
  amount: number | null;
  lostReason: string | null;
  data: Record<string, string>;
  events: DashboardEvent[];
  followups: { id: string; createdAt: string; completedAt: string | null; message?: string; dueAt?: string | null; assignedTo?: string | null; }[];
}

export interface DashboardJob {
  id: string;
  requestId: string;
  kind: RuleKey;
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled';
  runAt: string;
  attempts: number;
  error: string | null;
}

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

export type DashboardAction =
  | { action: 'createCompany'; name: string; industry: Industry }
  | { action: 'createRequest'; name: string; email: string; phone: string; service: string; origin: string; priority: RequestPriority; data: Record<string,string> }
  | { action: 'updateRequest'; requestId: string; status?: string; priority?: RequestPriority; assigneeId?: string | null; followupAt?: string | null; appointmentAt?: string | null; nextAction?: string | null; outcome?: RequestOutcome; amount?: number | null; lostReason?: string | null }
  | { action: 'addEvent'; requestId: string; kind: 'note' | 'contact' | 'completeFollowup'; text: string; followupId?: string }
  | { action: 'requestInfo'; requestId: string; fields: string[] }
  | { action: 'updateCompany'; settings: Pick<DashboardCompany, 'name' | 'logoUrl' | 'color' | 'timezone' | 'businessHours' | 'services' | 'fields' | 'statuses' | 'rules'> }
  | { action: 'deleteRequest'; requestId: string }
  | { action: 'retryJob'; jobId: string }
  | { action: 'addMember'; email: string; role: DashboardRole };
