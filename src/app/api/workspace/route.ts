import { currentUser } from "@/lib/auth";
import { sameOrigin } from "@/lib/origin";
import { mutateWorkspace, readWorkspace, workspaceErrorResponse } from "@/lib/workspace";

export async function GET(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: "Inicia sesión." }, { status: 401 });
    const selected = new URL(request.url).searchParams.get("company");
    return Response.json(await readWorkspace(user, selected), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return workspaceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Origen no permitido." }, { status: 403 });
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: "Inicia sesión." }, { status: 401 });
    const body = await request.text();
    if (body.length > 256_000) return Response.json({ error: "La solicitud supera el tamaño permitido." }, { status: 413 });
    return Response.json(await mutateWorkspace(user, JSON.parse(body)));
  } catch (error) {
    return workspaceErrorResponse(error);
  }
}
