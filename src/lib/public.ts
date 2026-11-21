import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { computeBusinessDue, handleRequestCreated, type AutomationCompany } from "./automation";
import { withCompletion, withPublicCompany } from "./db";
import type { PublicField } from "./public-types";

type CompanyRow = AutomationCompany & {
  logo_url: string | null;
  primary_color: string;
};

type Service = { id: string; name: string };
type Answer = string | number | boolean;

export type PublicBrand = { name: string; logoUrl: string | null; color: string };

export class PublicFormError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[\d ().-]{6,31}$/;
const decimalPattern = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,3})?$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const unavailable = "El enlace ya no está disponible. Pide uno nuevo al negocio.";

export function normalizeSource(input: unknown) {
  if (typeof input !== "string") return "web";
  const source = input.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 60).trim();
  if (source === "teléfono" || source === "telefono") return "phone";
  return source || "web";
}

async function companyInfo(client: PoolClient, companyId: string) {
  const { rows } = await client.query<CompanyRow>("SELECT * FROM companies WHERE id = $1", [companyId]);
  return rows[0];
}

function publicBrand(company: CompanyRow): PublicBrand {
  const color = /^#[\da-f]{6}$/i.test(company.primary_color) ? company.primary_color : "#205b4b";
  let logoUrl = null;
  if (company.logo_url) {
    try {
      const url = new URL(company.logo_url);
      if (url.protocol === "https:" && !url.username && !url.password) logoUrl = url.href;
    } catch {
      // Treat an invalid image as an unset image.
    }
  }
  return { name: company.name, logoUrl, color };
}

async function formFields(client: PoolClient, companyId: string) {
  const fields = await client.query<PublicField>(
    "SELECT key, label, type, required, options FROM form_fields WHERE company_id = $1 ORDER BY position, id",
    [companyId],
  );
  return fields.rows.map((field) => ({ ...field, options: Array.isArray(field.options) ? field.options : [] }));
}

async function activeServices(client: PoolClient, companyId: string) {
  const services = await client.query<Service>(
    "SELECT id, name FROM services WHERE company_id = $1 AND active ORDER BY position, id",
    [companyId],
  );
  return services.rows;
}

export async function getPublicForm(slug: string) {
  if (!slugPattern.test(slug)) return null;
  return withPublicCompany(slug, async (client, companyId) => {
    const company = await companyInfo(client, companyId);
    if (!company) return null;
    const services = await activeServices(client, companyId);
    const fields = await formFields(client, companyId);
    return { brand: publicBrand(company), services, fields };
  });
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicFormError("El formulario contiene datos no válidos.");
  }
  return value as Record<string, unknown>;
}

function textInput(value: unknown, label: string, max: number) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw new PublicFormError(`Revisa el campo «${label}».`);
  }
  return value.trim();
}

function validPhone(value: string) {
  return phonePattern.test(value) && value.replace(/\D/g, "").length >= 6;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

function fieldsInput(input: unknown, fields: PublicField[]) {
  const answers = inputObject(input ?? {});
  const fieldKeys = new Set(fields.map(({ key }) => key));
  if (Object.keys(answers).some((key) => !fieldKeys.has(key))) {
    throw new PublicFormError("El formulario ha cambiado. Vuelve a abrirlo para ver los campos actualizados.");
  }
  const values: Array<[string, Answer]> = [];
  for (const field of fields) {
    const value = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    if (value === undefined || value === null || value === "" || (typeof value === "string" && !value.trim())) {
      if (field.required) throw new PublicFormError(`Completa el campo «${field.label}».`);
      continue;
    }
    if (field.type === "checkbox") {
      if (typeof value !== "boolean" || (field.required && !value)) {
        throw new PublicFormError(`Revisa el campo «${field.label}».`);
      }
      values.push([field.key, value]);
      continue;
    }
    if (field.type === "number") {
      const candidate = typeof value === "string" ? value.trim() : value;
      const number = typeof candidate === "number" ? candidate
        : typeof candidate === "string" && candidate.length <= 40 && decimalPattern.test(candidate) ? Number(candidate) : NaN;
      if (!Number.isFinite(number)) throw new PublicFormError(`Introduce un número en «${field.label}».`);
      values.push([field.key, number]);
      continue;
    }
    const text = textInput(value, field.label, field.type === "textarea" ? 3000 : 500);
    if (
      (field.type === "email" && (text.length > 254 || !emailPattern.test(text))) ||
      (field.type === "tel" && !validPhone(text)) ||
      (field.type === "date" && !validDate(text)) ||
      (field.type === "select" && !field.options.includes(text))
    ) {
      throw new PublicFormError(`Revisa el valor de «${field.label}».`);
    }
    values.push([field.key, text]);
  }
  return Object.fromEntries(values);
}

export async function submitPublicForm(slug: string, value: unknown, clientIp: string) {
  if (!slugPattern.test(slug)) throw new PublicFormError("El formulario no está disponible.", 404);
  const input = inputObject(value);
  if (typeof input.website === "string" && input.website.trim()) return randomUUID();
  const name = textInput(input.name, "Nombre", 120);
  const email = textInput(input.email, "Email", 254).toLowerCase() || null;
  const phone = textInput(input.phone, "Teléfono", 32) || null;
  const source = normalizeSource(input.source);
  if (!name) throw new PublicFormError("Introduce tu nombre.");
  if (email && !emailPattern.test(email)) throw new PublicFormError("Introduce un email válido.");
  if (phone && !validPhone(phone)) throw new PublicFormError("Introduce un teléfono válido.");
  if (!email && !phone) throw new PublicFormError("Introduce tu email o tu teléfono.");
  const serviceId = textInput(input.serviceId, "Servicio", 36);
  if (serviceId && !uuidPattern.test(serviceId)) throw new PublicFormError("Selecciona un servicio válido.");

  const id = await withPublicCompany(slug, async (client, companyId) => {
    const company = await companyInfo(client, companyId);
    if (!company) return null;
    const services = await activeServices(client, companyId);
    const service = services.find((item) => item.id === serviceId);
    if ((services.length > 0 || serviceId) && !service) {
      throw new PublicFormError("Selecciona un servicio disponible.");
    }
    const fields = await formFields(client, companyId);
    const answers = fieldsInput(input.answers, fields);
    const status = await client.query<{ id: string }>(
      "SELECT id FROM statuses WHERE company_id = $1 AND kind = 'open' ORDER BY position, id LIMIT 1",
      [companyId],
    );
    if (!status.rows[0]) throw new PublicFormError("El formulario está temporalmente cerrado.", 503);

    const fingerprint = createHash("sha256").update(`${companyId}:${clientIp}`).digest("hex");
    const rate = await client.query<{ hits: number }>(
      `INSERT INTO public_rate_limits (company_id, fingerprint, bucket, hits)
       VALUES ($1, $2, date_trunc('hour', now(), 'UTC'), 1)
       ON CONFLICT (company_id, fingerprint, bucket) DO UPDATE SET hits = public_rate_limits.hits + 1
       RETURNING hits`,
      [companyId, fingerprint],
    );
    if (rate.rows[0].hits > 10) throw new PublicFormError("Has enviado varias solicitudes. Vuelve a intentarlo más tarde.", 429);

    const createdAt = new Date();
    const subject = service?.name ?? `Solicitud de ${name}`;
    const request = { id: randomUUID(), company_id: companyId, name, email, subject, created_at: createdAt };
    const due = computeBusinessDue(createdAt, company.timezone, company.business_hours, company.first_response_minutes);

    await client.query(
      `INSERT INTO requests
       (id, company_id, status_id, service_id, name, email, phone, subject, answers, source, sla_due_at, created_at, updated_at, state_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$12,$12)`,
      [request.id, companyId, status.rows[0].id, service?.id ?? null, name, email, phone, subject, JSON.stringify(answers), source, due, createdAt],
    );
    await client.query(
      `INSERT INTO events (company_id, request_id, kind, body, metadata)
       VALUES ($1, $2, 'created', 'Solicitud recibida desde el formulario público.', jsonb_build_object('source', $3::text))`,
      [companyId, request.id, source],
    );
    await handleRequestCreated(client, company, request);
    return request.id;
  });
  if (!id) throw new PublicFormError("El formulario no está disponible.", 404);
  return id;
}

function parseToken(token: string) {
  const separator = token.indexOf(".");
  const slug = token.slice(0, separator);
  const nonce = token.slice(separator + 1);
  if (separator < 1 || !slugPattern.test(slug) || !/^[\w-]{43}$/.test(nonce)) return null;
  return { slug, hash: createHash("sha256").update(token).digest("hex") };
}

export async function getCompletionForm(token: string) {
  const parsed = parseToken(token);
  if (!parsed) return null;
  return withCompletion(parsed.slug, parsed.hash, async (client, completion) => {
    const company = await companyInfo(client, completion.company_id);
    const fields = await completionFields(client, completion.company_id, completion.fields);
    return company && fields.length ? { brand: publicBrand(company), fields } : null;
  });
}

async function completionFields(client: PoolClient, companyId: string, keys: unknown) {
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) return [];
  const configured = await formFields(client, companyId);
  return keys.map((key) => {
    const field = configured.find((item) => item.key === key);
    return field ? { ...field, required: true } : { key, label: key, type: "text" as const, required: true, options: [] };
  });
}

export async function submitCompletionForm(token: string, value: unknown) {
  const parsed = parseToken(token);
  if (!parsed) throw new PublicFormError(unavailable, 404);
  const input = inputObject(value);
  const used = await withCompletion(parsed.slug, parsed.hash, async (client, completion) => {
    const fields = await completionFields(client, completion.company_id, completion.fields);
    if (!fields.length) throw new PublicFormError(unavailable, 404);
    const answers = fieldsInput(input.answers, fields);
    const result = await client.query(
      `UPDATE requests
       SET answers = answers || $3::jsonb, updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [completion.company_id, completion.request_id, JSON.stringify(answers)],
    );
    if (result.rowCount !== 1) throw new PublicFormError(unavailable, 404);
    await client.query(
      `INSERT INTO events (company_id, request_id, kind, body, metadata)
       VALUES ($1, $2, 'information_received', 'El cliente completó los datos solicitados.', $3::jsonb)`,
      [completion.company_id, completion.request_id, JSON.stringify({ fields: Object.keys(answers) })],
    );
    await client.query(
      "UPDATE completions SET used_at = now() WHERE company_id = $1 AND id = $2",
      [completion.company_id, completion.id],
    );
    return true;
  });
  if (!used) throw new PublicFormError(unavailable, 404);
}

export async function readPublicJson(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new PublicFormError("El formato del formulario no es compatible.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new PublicFormError("El formulario está vacío.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        throw new PublicFormError("El formulario contiene demasiados datos.", 413);
      }
      chunks.push(value);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return JSON.parse(chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof PublicFormError) throw error;
    throw new PublicFormError("El formulario contiene datos no válidos.");
  } finally {
    reader.releaseLock();
  }
}

export function publicErrorResponse(error: unknown) {
  if (error instanceof PublicFormError) {
    return Response.json({ error: error.message }, {
      status: error.status,
      headers: { "Cache-Control": "no-store", ...(error.status === 429 ? { "Retry-After": "3600" } : {}) },
    });
  }
  console.error("Error al procesar un formulario público", {
    name: error instanceof Error ? error.name : "Error desconocido",
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
  });
  return Response.json({ error: "No se pudo guardar el formulario. Inténtalo de nuevo." }, { status: 500 });
}
