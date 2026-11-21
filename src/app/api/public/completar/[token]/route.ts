import { publicErrorResponse, readPublicJson, submitCompletionForm } from "../../../../../lib/public";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const input = await readPublicJson(request);
    await submitCompletionForm(token, input);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicErrorResponse(error);
  }
}
