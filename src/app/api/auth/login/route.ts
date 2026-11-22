import { NextResponse } from "next/server";
import { z } from "zod";
import { createDemoSession, demoAccounts, sendLoginLink, supabaseConfigured } from "@/lib/auth";
import { requestOrigin, sameOrigin } from "@/lib/origin";

// Recibe tanto el formulario de acceso real por correo como los botones de la demo.
export async function POST(request: Request) {
  // Restringe el origen de las peticiones del navegador y extrae los campos enviados.
  const origin = requestOrigin(request);
  if (!sameOrigin(request)) return new Response("Origen no permitido", { status: 403 });
  const data = await request.formData();
  // Si se seleccionó una cuenta ficticia permitida, inicia su sesión y abre el panel.
  const account = data.get("demo");
  if (typeof account === "string" && Object.hasOwn(demoAccounts, account)) {
    if (await createDemoSession(account as keyof typeof demoAccounts)) {
      return NextResponse.redirect(new URL("/", origin), 303);
    }
  }
  // Valida el correo y confirma que Supabase está configurado antes de solicitar el enlace.
  const email = z.email().safeParse(data.get("email"));
  if (!email.success || !supabaseConfigured()) {
    return NextResponse.redirect(new URL("/login?error=1", origin), 303);
  }
  // Supabase enviará el enlace. El 303 vuelve a mostrar la pantalla de acceso mediante GET.
  const { error } = await sendLoginLink(email.data, new URL("/api/auth/callback", origin).href);
  return NextResponse.redirect(new URL(error ? "/login?error=1" : "/login?sent=1", origin), 303);
}
