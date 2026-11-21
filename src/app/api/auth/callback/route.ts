import { NextResponse } from "next/server";
import { exchangeLoginCode, supabaseConfigured } from "@/lib/auth";
import { requestOrigin } from "@/lib/origin";

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (code && supabaseConfigured()) {
    const result = await exchangeLoginCode(code);
    if (!result.error) return NextResponse.redirect(new URL("/", requestOrigin(request)));
  }
  return NextResponse.redirect(new URL("/login?error=1", requestOrigin(request)));
}
