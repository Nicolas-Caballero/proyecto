import { currentUser } from "@/lib/auth";
import { exportWorkspace, workspaceErrorResponse } from "@/lib/workspace";

export async function GET(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: "Inicia sesión." }, { status: 401 });
    const company = new URL(request.url).searchParams.get("company");
    if (!company) return Response.json({ error: "Selecciona una empresa." }, { status: 400 });
    const csv = await exportWorkspace(user, company);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="solicitudes-pulso.csv"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return workspaceErrorResponse(error);
  }
}
