import { summarizeMetrics } from '../lib/metrics';
import type { DashboardRequest } from './dashboard-types';

export function getAttentionReasons(request: DashboardRequest, now = Date.now()) {
  if (request.closedAt) return [];
  const reasons: string[] = [];
  if (!request.assigneeId) reasons.push('Sin responsable');
  if (!request.firstResponseAt && request.slaDueAt && Date.parse(request.slaDueAt) <= now) reasons.push('Fuera de plazo');
  if ((request.followupAt && Date.parse(request.followupAt) <= now)
    || request.followups.some((task) => !task.completedAt && task.dueAt && Date.parse(task.dueAt) <= now)) {
    reasons.push('Seguimiento vencido');
  }
  return reasons;
}

export function getDashboardMetrics(
  requests: DashboardRequest[],
  filter: { from?: string; to?: string; source?: string; now?: Date } = {},
) {
  return summarizeMetrics(
    requests.map((request) => ({ ...request, confirmedAmount: request.amount, source: request.origin })),
    requests.flatMap((request) => request.followups.map((task) => ({ ...task, requestId: request.id }))),
    filter,
  );
}
