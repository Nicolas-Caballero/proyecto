// Zod comparte con los formularios el criterio de dirección de correo válida.
import { z } from "zod";

// El adaptador distingue la simulación de desarrollo de un envío real por Resend.
export type MailMode = "development" | "resend";

// El trabajo de la cola proporciona el destinatario, el asunto y el cuerpo en texto plano.
export type MailMessage = { to: string; subject: string; text: string };

// Aplica el formato de correo y una longitud máxima de 254 caracteres.
const emailAddress = z.email().max(254);

// Selecciona Resend solo cuando se pide expresamente en la configuración del servidor.
export function mailMode(): MailMode {
  return process.env.MAIL_MODE === "resend" ? "resend" : "development";
}

// Además de validar el valor, permite tratarlo como texto una vez comprobado.
export function isValidEmail(value: string | null | undefined): value is string {
  return emailAddress.safeParse(value).success;
}

// Construye los enlaces públicos a partir de la dirección configurada.
export function applicationUrl(path: string): string {
  // Usa localhost como valor predeterminado de desarrollo y exige HTTPS para correo real.
  const base = process.env.APP_URL || process.env.APP_BASE_URL || (mailMode() === "development" ? "http://localhost:3000" : "");
  const url = URL.canParse(base) ? new URL(base) : null;
  if (!url || url.username || url.password || (url.protocol !== "https:" && mailMode() === "resend")) {
    throw new Error("Configura APP_URL con la dirección HTTPS de la aplicación para enviar enlaces.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APP_URL debe usar HTTP o HTTPS.");
  }
  // Combina la ruta pública con el origen validado y devuelve una URL absoluta.
  return new URL(path, url).href;
}

// Entrega el correo o devuelve el modo simulado para que el ejecutor lo registre.
export async function deliverMail(message: MailMessage, idempotencyKey: string): Promise<MailMode> {
  const mode = mailMode();
  if (mode === "development") {
    // El ejecutor registra el mensaje simulado en el historial de la solicitud en PostgreSQL.
    return mode;
  }
  // Lee las credenciales solo en el servidor y comprueba que el remitente está configurado.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) throw new Error("Configura RESEND_API_KEY y MAIL_FROM para enviar correo real.");

  let response: Response;
  try {
    // Envía el mensaje con la clave del trabajo, que Resend usa para reconocer reintentos.
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from, ...message }),
      // Limita a diez segundos la espera de la API externa.
      signal: AbortSignal.timeout(10_000),
    });
  // Traduce un fallo de conexión o tiempo de espera a un error que se puede registrar.
  } catch {
    throw new Error("No se pudo conectar con el proveedor de correo. Se puede reintentar.");
  }
  // Propaga el estado HTTP del proveedor para que el ejecutor pueda programar un reintento.
  if (!response.ok) throw new Error(`El proveedor de correo devolvió HTTP ${response.status}.`);
  return mode;
}
