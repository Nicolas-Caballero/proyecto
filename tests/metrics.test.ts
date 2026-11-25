import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMetrics } from "../src/lib/metrics";

test("el resumen calcula mediana de respuesta, cierres y secuencia de seguimiento", () => {
  // Las fechas y los importes fijos permiten calcular los resultados esperados a mano.
  const createdAt = "2026-06-01T09:00:00Z";
  const closedAt = "2026-06-02T11:00:00Z";
  const defaults = {
    createdAt, firstResponseAt: null, slaDueAt: "2026-06-01T10:00:00Z", closedAt: null,
    outcome: null, confirmedAmount: null, source: "instagram",
  };
  // El filtro de Instagram excluye la venta de Google y su seguimiento.
  // La solicitud sin respuesta sigue contando como recibida y vencida.
  const metrics = summarizeMetrics([
    { ...defaults, id: "1", firstResponseAt: "2026-06-01T09:10:00Z", closedAt, outcome: "won", confirmedAmount: 175 },
    { ...defaults, id: "2", firstResponseAt: "2026-06-01T09:30:00Z", closedAt, outcome: "lost" },
    { ...defaults, id: "3" },
    { ...defaults, id: "4", source: "google", outcome: "won", confirmedAmount: 25 },
  ], [
    { requestId: "1", createdAt, completedAt: "2026-06-02T10:00:00Z" },
    { requestId: "2", createdAt, completedAt: null },
    { requestId: "4", createdAt, completedAt: closedAt },
  ], { source: "instagram", now: new Date("2026-06-03T09:00:00Z") });

  // De las dos solicitudes resueltas se consiguió una, después de completar un seguimiento.
  assert.deepEqual(metrics, {
    received: 3, medianResponseMinutes: 20, overdue: 1, resolved: 2, won: 1, closeRate: 0.5,
    confirmedAmount: 175, followUpsGenerated: 2, followUpsCompleted: 1, wonAfterFollowUp: 1,
  });
});
