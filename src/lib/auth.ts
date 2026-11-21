import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { transaction } from "./db";

const cookieName = "pulso_demo";
const week = 7 * 24 * 60 * 60;

export const demoAccounts = {
  admin: { id: "00000000-0000-4000-8000-000000000001", email: "marta@pulso.demo" },
  employee: { id: "00000000-0000-4000-8000-000000000002", email: "lucia@pulso.demo" },
  workshop: { id: "00000000-0000-4000-8000-000000000003", email: "diego@pulso.demo" },
} as const;

export function supabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));
}

function demoSecret() {
  if (process.env.DEMO_MODE === "false") return null;
  if (process.env.NODE_ENV !== "production" && !supabaseConfigured()) {
    return process.env.DEMO_SESSION_SECRET || "pulso-local-demo-v1";
  }
  const secret = process.env.DEMO_SESSION_SECRET;
  return process.env.DEMO_MODE === "true" && secret && secret.length >= 32 ? secret : null;
}

export function demoEnabled() {
  return Boolean(demoSecret());
}

async function supabaseClient(writable = true) {
  const jar = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
    {
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (entries) => {
          if (!writable) return;
          for (const entry of entries) {
            jar.set(entry.name, entry.value, entry.options);
          }
        },
      },
    },
  );
}

export async function createDemoSession(account: keyof typeof demoAccounts) {
  const secret = demoSecret();
  if (!secret || !Object.hasOwn(demoAccounts, account)) return false;
  const data = `${account}.${Math.floor(Date.now() / 1000) + week}`;
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  (await cookies()).set(cookieName, `${data}.${signature}`, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: week,
  });
  return true;
}

export async function currentUser(writable = true) {
  const secret = demoSecret();
  const value = (await cookies()).get(cookieName)?.value;
  if (value && secret) {
    const [account, expiry, signature] = value.split(".");
    if (Object.hasOwn(demoAccounts, account) && /^\d+$/.test(expiry) &&
        Number(expiry) > Date.now() / 1000 && /^[a-f\d]{64}$/.test(signature)) {
      const expected = createHmac("sha256", secret).update(`${account}.${expiry}`).digest();
      if (timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
        return { ...demoAccounts[account as keyof typeof demoAccounts], demo: true };
      }
    }
  }

  if (!supabaseConfigured()) return null;
  const supabase = await supabaseClient(writable);
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;
  if (error || !user?.email || !user.email_confirmed_at) return null;
  return { id: user.id, email: user.email, demo: false };
}

export async function sendLoginLink(email: string, redirectTo: string) {
  const supabase = await supabaseClient();
  return supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
}

export async function exchangeLoginCode(code: string) {
  const supabase = await supabaseClient();
  const result = await supabase.auth.exchangeCodeForSession(code);
  if (!result.error && result.data.user.email && result.data.user.email_confirmed_at) {
    const { id, email } = result.data.user;
    await claimInvitations(id, email);
  }
  return result;
}

export async function claimInvitations(userId: string, email: string) {
  await transaction(async (client) => {
    await client.query(
      `WITH candidates AS (
         DELETE FROM company_invitations WHERE email = lower($2) RETURNING company_id, role, name, email
       )
       INSERT INTO memberships (company_id, user_id, role, name, email)
       SELECT company_id, $1, role, name, email FROM candidates
       ON CONFLICT (company_id, user_id) DO NOTHING`,
      [userId, email],
    );
  });
}

export async function logout() {
  (await cookies()).delete(cookieName);
  if (supabaseConfigured()) await (await supabaseClient()).auth.signOut();
}
