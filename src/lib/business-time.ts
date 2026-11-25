// Luxon convierte las horas del calendario de la empresa en instantes que se pueden comparar.
import { DateTime } from "luxon";

// El horario usa días de la semana del 0 al 6, con domingo como 0, y dos límites locales HH:mm.
export type BusinessHours = { days: number[]; start: string; end: string };

// Una empresa sin horario propio empieza con una jornada de lunes a viernes.
export const defaultBusinessHours: BusinessHours = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
};

// Valida el formato de 24 horas y devuelve cuántos minutos han pasado desde medianoche.
function parseTime(time: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

// Construye la hora de inicio o fin en el calendario local, aplicando la zona horaria de ese día.
function boundary(day: DateTime, minutes: number, timezone: string) {
  const instant = DateTime.fromObject({
    year: day.year,
    month: day.month,
    day: day.day,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  }, { zone: timezone });
  // Cuando el cambio de hora repite una hora local, elige la primera de sus dos ocurrencias.
  return Math.min(...instant.getPossibleOffsets().map((candidate) => candidate.toMillis()));
}

// Suma minutos de jornada a la fecha inicial y devuelve un instante que la aplicación puede guardar en UTC.
export function computeBusinessDue(
  createdAt: Date | string,
  timezone: string,
  hours: BusinessHours,
  minutes: number,
): Date | null {
  // Interpreta el instante de creación en el calendario de la empresa y descarta horarios inválidos o vacíos.
  const created = DateTime.fromJSDate(new Date(createdAt), { zone: timezone });
  const start = parseTime(hours.start);
  const end = parseTime(hours.end);
  const workingDays = new Set(hours.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
  if (!created.isValid || ![start, end, minutes].every(Number.isFinite) || !workingDays.size || end <= start || minutes < 0) {
    return null;
  }
  const createdMs = created.toMillis();
  let remaining = minutes * 60_000;
  // Avanza por días calendario para respetar los fines de semana y los cambios de horario de verano.
  for (let day = created.startOf("day"); day.isValid; day = day.plus({ days: 1 })) {
    if (!workingDays.has(day.weekday % 7)) continue;
    // El primer día solo cuenta desde la hora de creación o de apertura, la que ocurra más tarde.
    const from = Math.max(createdMs, boundary(day, start, timezone));
    const until = boundary(day, end, timezone);
    if (from >= until) continue;
    // Si el tiempo restante cabe en la jornada, devuelve el vencimiento. Si no, descuenta esa jornada y
    // continúa.
    const available = until - from;
    if (remaining <= available) return new Date(from + remaining);
    remaining -= available;
  }
  return null;
}
