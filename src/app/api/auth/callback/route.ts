import { NextResponse } from "next/server";
import { exchangeLoginCode, supabaseConfigured } from "@/lib/auth";
import { requestOrigin } from "@/lib/origin";

// Recibe el código del enlace de acceso y redirige al panel si se pudo crear una sesión.
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (code && supabaseConfigured()) {
    const result = await exchangeLoginCode(code);
    if (!result.error) return NextResponse.redirect(new URL("/", requestOrigin(request)));
  }
  // Vuelve al inicio de sesión con un error si falta el código o Supabase lo rechaza.
  return NextResponse.redirect(new URL("/login?error=1", requestOrigin(request)));
}
