import { timingSafeEqual } from "node:crypto";
import { runJobs } from "@/lib/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET no está configurado." }, { status: 503 });
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: "Acceso denegado." }, { status: 401 });
  }
  return Response.json(await runJobs());
}

export const GET = handle;
export const POST = handle;
