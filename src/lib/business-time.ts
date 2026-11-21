import { DateTime } from "luxon";

export type BusinessHours = { days: number[]; start: string; end: string };

export const defaultBusinessHours: BusinessHours = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
};

function parseTime(time: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function boundary(day: DateTime, minutes: number, timezone: string) {
  const instant = DateTime.fromObject({
    year: day.year,
    month: day.month,
    day: day.day,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  }, { zone: timezone });
  // A repeated local time has two instants. Use the earlier one consistently.
  return Math.min(...instant.getPossibleOffsets().map((candidate) => candidate.toMillis()));
}

export function computeBusinessDue(
  createdAt: Date | string,
  timezone: string,
  hours: BusinessHours,
  minutes: number,
): Date | null {
  const created = DateTime.fromJSDate(new Date(createdAt), { zone: timezone });
  const start = parseTime(hours.start);
  const end = parseTime(hours.end);
  const workingDays = new Set(hours.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
  if (!created.isValid || ![start, end, minutes].every(Number.isFinite) || !workingDays.size || end <= start || minutes < 0) {
    return null;
  }
  const createdMs = created.toMillis();
  let remaining = minutes * 60_000;
  for (let day = created.startOf("day"); day.isValid; day = day.plus({ days: 1 })) {
    if (!workingDays.has(day.weekday % 7)) continue;
    const from = Math.max(createdMs, boundary(day, start, timezone));
    const until = boundary(day, end, timezone);
    if (from >= until) continue;
    const available = until - from;
    if (remaining <= available) return new Date(from + remaining);
    remaining -= available;
  }
  return null;
}
