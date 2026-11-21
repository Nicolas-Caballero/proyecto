import { NextResponse } from "next/server";
import { logout } from "@/lib/auth";
import { requestOrigin, sameOrigin } from "@/lib/origin";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response("Origen no permitido", { status: 403 });
  await logout();
  return NextResponse.redirect(new URL("/login", requestOrigin(request)), 303);
}
