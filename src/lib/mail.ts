import { z } from "zod";

export type MailMode = "development" | "resend";

export type MailMessage = { to: string; subject: string; text: string };

const emailAddress = z.email().max(254);

export function mailMode(): MailMode {
  return process.env.MAIL_MODE === "resend" ? "resend" : "development";
}

export function isValidEmail(value: string | null | undefined): value is string {
  return emailAddress.safeParse(value).success;
}

export function applicationUrl(path: string): string {
  const base = process.env.APP_URL || process.env.APP_BASE_URL || (mailMode() === "development" ? "http://localhost:3000" : "");
  const url = URL.canParse(base) ? new URL(base) : null;
  if (!url || url.username || url.password || (url.protocol !== "https:" && mailMode() === "resend")) {
    throw new Error("Configura APP_URL con la dirección HTTPS de la aplicación para enviar enlaces.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APP_URL debe usar HTTP o HTTPS.");
  }
  return new URL(path, url).href;
}

export async function deliverMail(message: MailMessage, idempotencyKey: string): Promise<MailMode> {
  const mode = mailMode();
  if (mode === "development") {
    // The worker records this simulated mail against the request in PostgreSQL.
    return mode;
  }
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) throw new Error("Configura RESEND_API_KEY y MAIL_FROM para enviar correo real.");

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from, ...message }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("No se pudo conectar con el proveedor de correo. Se puede reintentar.");
  }
  if (!response.ok) throw new Error(`El proveedor de correo devolvió HTTP ${response.status}.`);
  return mode;
}
