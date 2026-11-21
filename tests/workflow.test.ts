import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { getAttentionReasons } from "../src/components/dashboard-metrics";
import type { DashboardData } from "../src/components/dashboard-types";
import { closeDb } from "../src/lib/db";
import { runJobs } from "../src/lib/automation";

const app = (process.env.TEST_APP_URL || "http://localhost:3000").replace(/\/$/, "");
const run = `prueba-${randomUUID().slice(0, 8)}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const employeeId = "00000000-0000-4000-8000-000000000002";
const companiesToDelete: string[] = [];
const slug = { salon: "estudio-norte", workshop: "motor-barrio" } as const;
let admin: string;
let employee: string;
let salon: DashboardData;
let workshop: DashboardData;

async function login(account: string) {
  const response = await fetch(`${app}/api/auth/login`, {
    method: "POST",
    body: new URLSearchParams({ demo: account }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { Origin: new URL(app).origin },
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith("pulso_demo="));
  assert.ok(cookie, `La cuenta demo ${account} debe iniciar sesión`);
  return cookie.split(";", 1)[0];
}

async function call(path: string, options: { cookie?: string; data?: object } = {}) {
  const { cookie, data } = options;
  return fetch(app + path, {
    method: data ? "POST" : "GET",
    headers: {
      ...(cookie && { Cookie: cookie }),
      ...(data && { "Content-Type": "application/json", Origin: new URL(app).origin }),
    },
    body: data ? JSON.stringify(data) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

async function expectStatus(response: Response, status: number) {
  const detail = response.status !== status && response.headers.get("content-type")?.includes("application/json")
    ? (await response.clone().text()).slice(0, 500) : response.statusText;
  assert.equal(response.status, status, detail);
}

async function workspace(company: string, cookie = admin) {
  const response = await call(`/api/workspace?company=${encodeURIComponent(company)}`, { cookie });
  await expectStatus(response, 200);
  return response.json() as Promise<DashboardData>;
}

async function action(company: string, data: object, cookie = admin) {
  return call("/api/workspace", { cookie, data: { company, ...data } });
}

async function change(company: string, data: object) {
  const response = await action(company, data);
  assert.ok(response.ok, await response.text());
}

async function addCompany(industry: "workshop" | "salon") {
  const name = `${run}-${companiesToDelete.length + 1}`;
  await change(slug.salon, { action: "createCompany", name, industry });
  const result = await pool.query<{ id: string; slug: string }>("SELECT id, slug FROM companies WHERE name = $1", [name]);
  assert.equal(result.rowCount, 1);
  const company = result.rows[0];
  companiesToDelete.push(company.id);
  const resultData = await workspace(company.slug);
  assert.ok(resultData.company);
  return { ...company, settings: resultData.company };
}

async function publicPayload(companyId: string) {
  const services = await pool.query<{ id: string }>(
    "SELECT id FROM services WHERE company_id = $1 AND active ORDER BY position LIMIT 1", [companyId],
  );
  const fields = await pool.query<{ key: string; type: string; options: string[] }>(
    "SELECT key, type, options FROM form_fields WHERE company_id = $1 AND required ORDER BY position", [companyId],
  );
  const values: Record<string, string | number | boolean> = {
    text: "Disponible por la tarde", textarea: "Solicitud ficticia para las pruebas",
    date: "2026-06-05", number: 2, email: `${run}@example.test`, tel: "+34610000000", checkbox: true,
  };
  return {
    name: "Cliente de prueba",
    email: `${run}@example.test`,
    source: "instagram",
    serviceId: services.rows[0]?.id,
    answers: Object.fromEntries(fields.rows.map((field) =>
      [field.key, field.type === "select" ? field.options[0] : values[field.type]])),
  };
}

async function addRequest(companyId: string, statusId: string, options: {
  source?: string; assignedTo?: string; slaDueAt?: Date;
} = {}) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO requests (company_id,status_id,subject,name,email,source,assigned_to,sla_due_at)
     VALUES ($1,$2,'Solicitud ficticia','Cliente de prueba',$3,$4,$5,$6) RETURNING id`,
    [companyId, statusId, `${run}@example.test`, options.source ?? run, options.assignedTo ?? null, options.slaDueAt ?? null],
  );
  return result.rows[0].id;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "Configura DATABASE_URL con la misma base local de la aplicación de prueba");
  assert.equal(process.env.MAIL_MODE === "resend", false, "Las pruebas usan correo simulado");
  [admin, employee] = await Promise.all([login("admin"), login("employee")]);
  [salon, workshop] = await Promise.all([workspace(slug.salon), workspace(slug.workshop)]);
  assert.ok(salon.company && workshop.company, "Ejecuta npm run db:seed antes de iniciar la app");
  assert.equal(salon.mailMode, "simulated", "Inicia la aplicación de prueba con correo simulado");
});

after(async () => {
  try {
    if (companiesToDelete.length) {
      await pool.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [companiesToDelete]);
    }
  } finally {
    await Promise.all([pool.end(), closeDb()]);
  }
});

test("las dos empresas utilizan formularios y estados propios", async () => {
  assert.ok(salon.company && workshop.company);
  const labels = (data: DashboardData) => data.company!.fields.map((field) => field.label);
  const states = (data: DashboardData) => data.company!.statuses.map((status) => status.label);
  assert.ok(labels(salon).length > 0 && labels(workshop).length > 0);
  assert.notDeepEqual(labels(salon), labels(workshop));
  assert.notDeepEqual(states(salon), states(workshop));

  for (const demo of [salon.company, workshop.company]) {
    const response = await call(`/f/${demo.slug}?origen=instagram`);
    await expectStatus(response, 200);
    const html = await response.text();
    assert.ok(html.includes(demo.name));
    assert.ok(html.includes(demo.fields[0].label));
  }
});

test("la sesión de empleado y PostgreSQL aíslan búsquedas, cambios, CSV y trabajos", async () => {
  assert.ok(salon.company && workshop.company);
  const workshopRequest = workshop.requests[0];
  assert.ok(workshopRequest);
  const scoped = await workspace(slug.salon, employee);
  assert.deepEqual(scoped.companies.map((company) => company.slug), [slug.salon]);
  assert.equal(scoped.requests.some((request) => request.id === workshopRequest.id), false);

  await expectStatus(await call(`/api/workspace?company=${slug.workshop}&q=${encodeURIComponent(workshopRequest.name)}`, {
    cookie: employee,
  }), 403);
  await expectStatus(await action(slug.salon, {
    action: "updateRequest", requestId: workshopRequest.id, priority: "high",
  }, employee), 404);
  await expectStatus(await action(slug.workshop, {
    action: "updateRequest", requestId: workshopRequest.id, priority: "high",
  }, employee), 403);
  await expectStatus(await call(`/api/workspace/export?company=${slug.workshop}`, { cookie: employee }), 403);
  await expectStatus(await call(`/api/workspace/export?company=${slug.salon}`, { cookie: employee }), 403);
  const csv = await call(`/api/workspace/export?company=${slug.salon}`, { cookie: admin });
  await expectStatus(csv, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.ok(!(await csv.text()).includes(workshopRequest.id));

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE app_runtime");
    await db.query("SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)", [
      salon.company.id, employeeId,
    ]);
    const owned = await db.query("SELECT id FROM requests WHERE company_id = $1", [salon.company.id]);
    assert.ok(owned.rowCount);
    assert.equal((await db.query("SELECT id FROM requests WHERE company_id = $1", [workshop.company.id])).rowCount, 0);
    assert.equal((await db.query("UPDATE requests SET priority = 'high' WHERE id = $1", [workshopRequest.id])).rowCount, 0);
    await db.query("ROLLBACK");

    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE app_worker");
    await db.query("SELECT set_config('app.company_id', $1, true)", [salon.company.id]);
    assert.equal((await db.query("SELECT id FROM jobs WHERE company_id = $1", [workshop.company.id])).rowCount, 0);
    assert.equal((await db.query("UPDATE jobs SET status = 'cancelled' WHERE company_id = $1", [
      workshop.company.id,
    ])).rowCount, 0);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("un envío público validado llega a la bandeja, se asigna y se cierra", async () => {
  const company = await addCompany("salon");
  const publicPath = `/api/public/f/${company.slug}`;
  const payload = await publicPayload(company.id);
  await expectStatus(await call(publicPath, { data: { ...payload, answers: {} } }), 400);
  const created = await call(publicPath, { data: payload });
  await expectStatus(created, 201);
  const { id } = await created.json() as { id: string };
  await runJobs({ companyId: company.id });
  const opened = await workspace(company.slug);
  const request = opened.requests.find((item) => item.id === id);
  assert.ok(request);
  assert.equal(request.origin, "instagram");
  assert.ok(request.events.some(({ kind }) => kind === "email_simulated"));
  assert.equal(request.firstResponseAt, null);
  const member = opened.members.find(({ role }) => role === "admin");
  assert.ok(member);

  await change(company.slug, { action: "updateRequest", requestId: id, assigneeId: member.id });
  await change(company.slug, { action: "addEvent", requestId: id, kind: "note", text: "Nota interna de prueba" });
  assert.equal((await workspace(company.slug)).requests.find((item) => item.id === id)?.firstResponseAt, null);
  await change(company.slug, { action: "addEvent", requestId: id, kind: "contact", text: "Llamada realizada" });
  const closedStatus = company.settings.statuses.find((status) => status.kind === "closed");
  assert.ok(closedStatus);
  await change(company.slug, {
    action: "updateRequest", requestId: id, status: closedStatus.id, outcome: "won", amount: 65,
  });
  const latest = (await workspace(company.slug)).requests.find((item) => item.id === id);
  assert.ok(latest?.firstResponseAt && latest.closedAt);
  assert.equal(latest.assigneeId, member.id);
  assert.equal(latest.outcome, "won");
  assert.equal(latest.amount, 65);
});

test("la solicitud vencida figura en Requiere atención por estar fuera de plazo", async () => {
  const company = await addCompany("salon");
  const open = company.settings.statuses.find((status) => status.kind === "open");
  const dashboard = await workspace(company.slug);
  const owner = dashboard.members.find(({ role }) => role === "admin");
  assert.ok(open && owner);
  const requestId = await addRequest(company.id, open.id, {
    assignedTo: owner.id, slaDueAt: new Date(Date.now() - 60_000),
  });

  const request = (await workspace(company.slug)).requests.find(({ id }) => id === requestId);
  assert.ok(request);
  assert.deepEqual(getAttentionReasons(request, Date.now()), ["Fuera de plazo"]);
});

test("los ejecutores concurrentes generan un único seguimiento de presupuesto", async () => {
  const company = await addCompany("workshop");
  const other = await addCompany("workshop");
  const open = company.settings.statuses.find((status) => status.kind === "open");
  const quote = company.settings.statuses.find((status) => status.kind === "quote");
  const otherOpen = other.settings.statuses.find((status) => status.kind === "open");
  const otherQuote = other.settings.statuses.find((status) => status.kind === "quote");
  assert.ok(open && quote && otherOpen && otherQuote);

  const id = await addRequest(company.id, open.id);
  const otherId = await addRequest(other.id, otherOpen.id);
  await change(company.slug, { action: "updateRequest", requestId: id, status: quote.id });
  await change(other.slug, { action: "updateRequest", requestId: otherId, status: otherQuote.id });

  const findQuote = (requestId: string) => pool.query<{ status: string; available_at: Date }>(
    "SELECT status, available_at FROM jobs WHERE request_id = $1 AND type = 'quote'", [requestId],
  );
  const jobs = await findQuote(id);
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].status, "pending");
  const otherJobs = await findQuote(otherId);
  assert.equal(otherJobs.rowCount, 1);
  const now = new Date(jobs.rows[0].available_at.getTime() + 1000);
  await Promise.all([runJobs({ companyId: company.id, now }), runJobs({ companyId: company.id, now })]);
  await runJobs({ companyId: company.id, now });

  const tasks = await pool.query("SELECT id FROM follow_ups WHERE request_id = $1", [id]);
  assert.equal(tasks.rowCount, 1);
  assert.equal((await findQuote(id)).rows[0].status, "completed");
  assert.equal((await findQuote(otherId)).rows[0].status, "pending");
  assert.equal((await pool.query("SELECT id FROM follow_ups WHERE request_id = $1", [otherId])).rowCount, 0);
});

test("reprogramar y cancelar la cita invalida sus recordatorios pendientes", async () => {
  const company = await addCompany("salon");
  const open = company.settings.statuses.find((status) => status.kind === "open");
  const confirmed = company.settings.statuses.find((status) => status.kind === "appointment");
  assert.ok(open && confirmed);
  const requestId = await addRequest(company.id, open.id);

  const day = 24 * 60 * 60 * 1000;
  const appointment = new Date(Date.now() + 7 * day);
  const rescheduled = new Date(appointment.getTime() + 2 * day);
  const listReminders = () => pool.query<{ id: string; available_at: Date; status: string }>(
    "SELECT id, available_at, status FROM jobs WHERE request_id = $1 AND type = 'appointment' ORDER BY available_at",
    [requestId],
  );
  await change(company.slug, { action: "updateRequest", requestId, status: confirmed.id, appointmentAt: appointment.toISOString() });
  const initial = await listReminders();
  assert.equal(initial.rowCount, 1);
  assert.equal(initial.rows[0].status, "pending");

  await change(company.slug, { action: "updateRequest", requestId, appointmentAt: rescheduled.toISOString() });
  assert.deepEqual((await listReminders()).rows.map((job) => job.status), ["cancelled", "pending"]);
  await runJobs({ companyId: company.id, now: new Date(initial.rows[0].available_at.getTime() + 1000) });

  await change(company.slug, { action: "updateRequest", requestId, appointmentAt: null });
  await runJobs({ companyId: company.id, now: new Date(rescheduled.getTime() + day) });
  assert.deepEqual((await listReminders()).rows.map((job) => job.status), ["cancelled", "cancelled"]);

  const thirdDate = new Date(rescheduled.getTime() + 3 * day).toISOString();
  await change(company.slug, { action: "updateRequest", requestId, status: confirmed.id, appointmentAt: thirdDate });
  assert.equal((await listReminders()).rows.at(-1)?.status, "pending");
  await change(company.slug, { action: "updateRequest", requestId, status: open.id, appointmentAt: thirdDate });
  assert.equal((await workspace(company.slug)).requests.find(({ id }) => id === requestId)?.appointmentAt, null);
  assert.equal((await listReminders()).rows.at(-1)?.status, "cancelled");
});

test("un enlace de datos permite completar solo su solicitud y su selección una vez", async () => {
  const company = await addCompany("workshop");
  const open = company.settings.statuses.find((status) => status.kind === "open");
  assert.ok(open);
  const requestId = await addRequest(company.id, open.id);
  const unrelated = await addRequest(company.id, open.id);
  const field = company.settings.fields.find(({ label }) => label.toLocaleLowerCase("es").includes("matrícula"));
  assert.ok(field);

  await change(company.slug, { action: "requestInfo", requestId, fields: [field.id] });
  await runJobs({ companyId: company.id });
  const messages = await pool.query<{ body: string }>(
    "SELECT body FROM events WHERE request_id = $1 AND kind = 'email_simulated' AND metadata->>'type' = 'information'",
    [requestId],
  );
  const token = messages.rows[0]?.body.match(/\/completar\/([a-z0-9-]+\.[A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(token, "El mensaje de datos pendientes incluye un enlace");
  const { rows: fields } = await pool.query<{ key: string }>(
    "SELECT key FROM form_fields WHERE company_id = $1 AND label = $2", [company.id, field.label],
  );
  assert.equal(fields.length, 1);
  const key = fields[0].key;
  const path = `/api/public/completar/${encodeURIComponent(token)}`;
  const page = await call(`/completar/${encodeURIComponent(token)}`);
  await expectStatus(page, 200);
  assert.ok((await page.text()).includes(field.label));

  const tampered = `${slug.salon}.${token.split(".")[1]}`;
  await expectStatus(await call(`/api/public/completar/${encodeURIComponent(tampered)}`, {
    data: { answers: { [key]: "1234BCD" } },
  }), 404);
  await expectStatus(await call(path, { data: { answers: { [key]: "1234BCD", extra: "Otro dato" } } }), 400);
  await expectStatus(await call(path, { data: { answers: { [key]: "1234BCD" } } }), 200);
  await expectStatus(await call(path, { data: { answers: { [key]: "9999ZZZ" } } }), 404);

  const { rows } = await pool.query<{ id: string; answers: Record<string, unknown> }>(
    "SELECT id, answers FROM requests WHERE id = ANY($1::uuid[])", [[requestId, unrelated]],
  );
  assert.deepEqual(rows.find((item) => item.id === requestId)?.answers, { [key]: "1234BCD" });
  assert.deepEqual(rows.find((item) => item.id === unrelated)?.answers, {});
});
