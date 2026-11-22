// Campos de la solicitud que alimentan el resumen del panel.
export type MetricRequest = {
  id: string;
  createdAt: string;
  firstResponseAt: string | null;
  slaDueAt: string | null;
  closedAt: string | null;
  outcome: "won" | "lost" | null;
  confirmedAmount: number | null;
  source: string;
};
// Datos de un seguimiento y de la solicitud a la que pertenece.
export type MetricFollowUp = {
  requestId: string;
  createdAt: string;
  completedAt: string | null;
};

// Calcula los indicadores a partir de las solicitudes visibles y de su historial de seguimientos.
export function summarizeMetrics(
  requests: MetricRequest[],
  followUps: MetricFollowUp[],
  filter: { from?: string; to?: string; source?: string; now?: Date } = {},
) {
  // Usa la hora actual por defecto. La hora inyectada permite reproducir el resultado en las pruebas.
  const now = filter.now?.getTime() ?? Date.now();
  const from = filter.from ? Date.parse(filter.from) : -Infinity;
  const to = filter.to ? Date.parse(filter.to) : Infinity;
  // Incluye las solicitudes creadas dentro del periodo, con inicio incluido y fin excluido, y del origen elegido.
  const matches = requests.filter((request) => {
    const created = Date.parse(request.createdAt);
    return created >= from && created < to && (!filter.source || request.source === filter.source);
  });
  // Busca la primera respuesta humana y convierte el tiempo transcurrido a minutos.
  const responseTimes = matches.flatMap((request) => request.firstResponseAt
    ? [(Date.parse(request.firstResponseAt) - Date.parse(request.createdAt)) / 60_000] : []
  ).filter((minutes) => minutes >= 0).sort((a, b) => a - b);
  // Para una lista par, la mediana es el promedio de los dos valores centrales. Una lista vacía devuelve null.
  const midpoint = Math.floor(responseTimes.length / 2);
  const medianResponseMinutes = !responseTimes.length ? null : responseTimes.length % 2
    ? responseTimes[midpoint]
    : (responseTimes[midpoint - 1] + responseTimes[midpoint]) / 2;
  // Las solicitudes ganadas se cuentan sobre las que tienen un resultado, ganadas o perdidas.
  const won = matches.filter((request) => request.outcome === "won");
  const resolved = matches.filter((request) => request.outcome !== null).length;
  // Relaciona cada seguimiento con una solicitud incluida en los filtros.
  const visible = new Set(matches.map((request) => request.id));
  const ownerFollowUps = followUps.filter((followUp) => visible.has(followUp.requestId));
  // Conserva la primera fecha de seguimiento completado para cada solicitud.
  const completedBefore = new Map<string, number>();
  for (const followUp of ownerFollowUps) {
    if (!followUp.completedAt) continue;
    const completed = Date.parse(followUp.completedAt);
    completedBefore.set(followUp.requestId, Math.min(completed, completedBefore.get(followUp.requestId) ?? Infinity));
  }
  // Devuelve los totales. Un seguimiento cuenta para una victoria solo si se completó antes del cierre o en ese momento.
  return {
    received: matches.length,
    medianResponseMinutes,
    overdue: matches.filter((request) =>
      !request.closedAt && !request.firstResponseAt && request.slaDueAt && Date.parse(request.slaDueAt) < now).length,
    resolved,
    won: won.length,
    closeRate: resolved ? won.length / resolved : null,
    confirmedAmount: won.reduce((total, request) => total + (request.confirmedAmount ?? 0), 0),
    followUpsGenerated: ownerFollowUps.length,
    followUpsCompleted: ownerFollowUps.filter((followUp) => followUp.completedAt).length,
    wonAfterFollowUp: won.filter((request) =>
      request.closedAt && (completedBefore.get(request.id) ?? Infinity) <= Date.parse(request.closedAt)).length,
  };
}
