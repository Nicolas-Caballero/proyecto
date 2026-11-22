// La ruta comprueba el secreto con una comparación de tiempo constante y delega el trabajo en la cola.
import { timingSafeEqual } from "node:crypto";
import { runJobs } from "@/lib/automation";

// Usa Node.js, vuelve a ejecutar la ruta en cada llamada y permite hasta sesenta segundos en plataformas
// compatibles.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Autoriza una llamada del cron antes de iniciar un lote y devuelve su resumen como JSON.
async function handle(request: Request) {
  // Un secreto sin configurar impide procesar trabajos por esta ruta.
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET no está configurado." }, { status: 503 });
  // Convierte la cabecera recibida y la esperada a bytes. La comparación segura requiere que tengan la misma
  // longitud.
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: "Acceso denegado." }, { status: 401 });
  }
  // Con la autenticación validada, el ejecutor lee la cola y devuelve el resultado.
  return Response.json(await runJobs());
}

// Acepta GET y POST para que distintos planificadores puedan usar la misma ruta protegida.
export const GET = handle;
export const POST = handle;
