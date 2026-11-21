import { publicErrorResponse, readPublicJson, submitPublicForm } from "../../../../../lib/public";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const input = await readPublicJson(request);
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    const ip = (forwarded || request.headers.get("x-real-ip") || "unknown").slice(0, 128);
    const id = await submitPublicForm(slug, input, ip);
    return Response.json({ ok: true, id }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicErrorResponse(error);
  }
}
