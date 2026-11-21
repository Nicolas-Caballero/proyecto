import { NextResponse } from "next/server";
import { z } from "zod";
import { createDemoSession, demoAccounts, sendLoginLink, supabaseConfigured } from "@/lib/auth";
import { requestOrigin, sameOrigin } from "@/lib/origin";

export async function POST(request: Request) {
  const origin = requestOrigin(request);
  if (!sameOrigin(request)) return new Response("Origen no permitido", { status: 403 });
  const data = await request.formData();
  const account = data.get("demo");
  if (typeof account === "string" && Object.hasOwn(demoAccounts, account)) {
    if (await createDemoSession(account as keyof typeof demoAccounts)) {
      return NextResponse.redirect(new URL("/", origin), 303);
    }
  }
  const email = z.email().safeParse(data.get("email"));
  if (!email.success || !supabaseConfigured()) {
    return NextResponse.redirect(new URL("/login?error=1", origin), 303);
  }
  const { error } = await sendLoginLink(email.data, new URL("/api/auth/callback", origin).href);
  return NextResponse.redirect(new URL(error ? "/login?error=1" : "/login?sent=1", origin), 303);
}
