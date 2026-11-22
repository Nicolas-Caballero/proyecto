import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { deliverMail } from "../src/lib/mail";

const message = { to: "cliente@example.com", subject: "Solicitud recibida", text: "Gracias por tu solicitud." };

/** Aísla las variables de correo de cada prueba y recupera su valor anterior al salir. */
function mailEnvironment(context: TestContext, variables: Record<string, string>) {
  for (const [name, value] of Object.entries(variables)) {
    const existing = process.env[name];
    process.env[name] = value;
    context.after(() => {
      if (existing === undefined) delete process.env[name];
      else process.env[name] = existing;
    });
  }
}

test("el correo simulado no contacta al proveedor", async (context) => {
  // Se sustituye fetch para poder comprobar que este modo no hace ninguna llamada HTTP.
  mailEnvironment(context, { MAIL_MODE: "log" });
  const send = context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
  assert.equal(await deliverMail(message, "request-job/simulated"), "development");
  assert.equal(send.mock.callCount(), 0);
});

test("los reintentos a Resend usan el mismo mensaje y la misma clave de idempotencia", async (context) => {
  mailEnvironment(context, { MAIL_MODE: "resend", MAIL_FROM: "empresa@example.com", RESEND_API_KEY: "test" });
  // El proveedor simulado falla en el primer intento y acepta el segundo.
  const attempts: RequestInit[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.resend.com/emails");
    attempts.push(options);
    return new Response(null, { status: attempts.length === 1 ? 503 : 200 });
  });
  // Conservar la clave y el cuerpo permite identificar ambos intentos como el mismo envío.
  const key = "request-job/job-id";
  await assert.rejects(deliverMail(message, key), /HTTP 503/);
  assert.equal(await deliverMail(message, key), "resend");
  assert.deepEqual(attempts.map((attempt) => new Headers(attempt.headers).get("Idempotency-Key")), [key, key]);
  assert.equal(attempts[0].body, attempts[1].body);
  assert.deepEqual(JSON.parse(String(attempts[0].body)), { ...message, from: "empresa@example.com" });
});
