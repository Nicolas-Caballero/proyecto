import assert from "node:assert/strict";
import test from "node:test";
import { computeBusinessDue, defaultBusinessHours } from "../src/lib/business-time";

test("el plazo laboral salta el fin de semana y aplica el cambio de hora de Madrid", () => {
  const due = computeBusinessDue(
    "2026-03-27T16:30:00Z",
    "Europe/Madrid",
    defaultBusinessHours,
    90,
  );
  assert.equal(due?.toISOString(), "2026-03-30T08:00:00.000Z");
});
