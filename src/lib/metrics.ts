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
export type MetricFollowUp = {
  requestId: string;
  createdAt: string;
  completedAt: string | null;
};

export function summarizeMetrics(
  requests: MetricRequest[],
  followUps: MetricFollowUp[],
  filter: { from?: string; to?: string; source?: string; now?: Date } = {},
) {
  const now = filter.now?.getTime() ?? Date.now();
  const from = filter.from ? Date.parse(filter.from) : -Infinity;
  const to = filter.to ? Date.parse(filter.to) : Infinity;
  const matches = requests.filter((request) => {
    const created = Date.parse(request.createdAt);
    return created >= from && created < to && (!filter.source || request.source === filter.source);
  });
  const responseTimes = matches.flatMap((request) => request.firstResponseAt
    ? [(Date.parse(request.firstResponseAt) - Date.parse(request.createdAt)) / 60_000] : []
  ).filter((minutes) => minutes >= 0).sort((a, b) => a - b);
  const midpoint = Math.floor(responseTimes.length / 2);
  const medianResponseMinutes = !responseTimes.length ? null : responseTimes.length % 2
    ? responseTimes[midpoint]
    : (responseTimes[midpoint - 1] + responseTimes[midpoint]) / 2;
  const won = matches.filter((request) => request.outcome === "won");
  const resolved = matches.filter((request) => request.outcome !== null).length;
  const visible = new Set(matches.map((request) => request.id));
  const ownerFollowUps = followUps.filter((followUp) => visible.has(followUp.requestId));
  const completedBefore = new Map<string, number>();
  for (const followUp of ownerFollowUps) {
    if (!followUp.completedAt) continue;
    const completed = Date.parse(followUp.completedAt);
    completedBefore.set(followUp.requestId, Math.min(completed, completedBefore.get(followUp.requestId) ?? Infinity));
  }
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
