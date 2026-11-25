import { summarizeMetrics } from '../lib/metrics';
import type { DashboardRequest } from './dashboard-types';

// Calcula los motivos que comparten la bandeja, el menú y los indicadores de atención.
export function getAttentionReasons(request: DashboardRequest, now = Date.now()) {
  // Las solicitudes cerradas ya no se cuentan como pendientes.
  if (request.closedAt) return [];
  // La ausencia de responsable y el incumplimiento del plazo son motivos independientes.
  const reasons: string[] = [];
  if (!request.assigneeId) reasons.push('Sin responsable');
  if (!request.firstResponseAt && request.slaDueAt && Date.parse(request.slaDueAt) <= now) reasons.push('Fuera de plazo');
  // Cuenta tanto la fecha fijada por el equipo como las tareas automáticas aún incompletas.
  if ((request.followupAt && Date.parse(request.followupAt) <= now)
    || request.followups.some((task) => !task.completedAt && task.dueAt && Date.parse(task.dueAt) <= now)) {
    reasons.push('Seguimiento vencido');
  }
  return reasons;
}

// Adapta los datos del panel al cálculo de métricas compartido.
export function getDashboardMetrics(
  requests: DashboardRequest[],
  filter: { from?: string; to?: string; source?: string; now?: Date } = {},
) {
  return summarizeMetrics(
    // El cálculo espera nombres de campos normalizados para el importe y el origen.
    requests.map((request) => ({ ...request, confirmedAmount: request.amount, source: request.origin })),
    // Aplana las tareas y conserva la referencia a su solicitud para aplicar los filtros.
    requests.flatMap((request) => request.followups.map((task) => ({ ...task, requestId: request.id }))),
    filter,
  );
}
