import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { transaction } from "./db";

// La cookie de demostración dura siete días. La duración se expresa en segundos.
const cookieName = "pulso_demo";
const week = 7 * 24 * 60 * 60;

// Las cuentas ficticias usan los mismos identificadores que los datos de ejemplo de la base de datos.
export const demoAccounts = {
  admin: { id: "00000000-0000-4000-8000-000000000001", email: "marta@pulso.demo" },
  employee: { id: "00000000-0000-4000-8000-000000000002", email: "lucia@pulso.demo" },
  workshop: { id: "00000000-0000-4000-8000-000000000003", email: "diego@pulso.demo" },
} as const;

// El acceso real necesita la URL de Supabase y una clave pública del proyecto.
export function supabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL &&
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));
}

// Determina si se puede firmar una sesión demo.
function demoSecret() {
  if (process.env.DEMO_MODE === "false") return null;
  // Permite probar el producto localmente sin una cuenta de Supabase.
  if (process.env.NODE_ENV !== "production" && !supabaseConfigured()) {
    return process.env.DEMO_SESSION_SECRET || "pulso-local-demo-v1";
  }
  // Fuera del caso anterior, la demo requiere activación explícita y un secreto de al menos 32 caracteres.
  const secret = process.env.DEMO_SESSION_SECRET;
  return process.env.DEMO_MODE === "true" && secret && secret.length >= 32 ? secret : null;
}

// La pantalla de acceso usa esta función para decidir si muestra las cuentas ficticias.
export function demoEnabled() {
  return Boolean(demoSecret());
}

// Crea un cliente Supabase para la petición actual y conecta sus cookies con las de Next.js.
async function supabaseClient(writable = true) {
  const jar = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)!,
    {
      // Las rutas pueden guardar las cookies renovadas. La página de servidor puede pedir acceso de solo lectura.
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

// Crea una sesión local para una cuenta demo válida y devuelve si pudo iniciarla.
export async function createDemoSession(account: keyof typeof demoAccounts) {
  const secret = demoSecret();
  if (!secret || !Object.hasOwn(demoAccounts, account)) return false;
  // Firma la cuenta y la caducidad juntas para impedir que se cambien sin invalidar la firma.
  const data = `${account}.${Math.floor(Date.now() / 1000) + week}`;
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  // httpOnly impide que JavaScript lea la cookie. En producción solo se envía por HTTPS.
  (await cookies()).set(cookieName, `${data}.${signature}`, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: week,
  });
  return true;
}

// Identifica al usuario a partir de una sesión demo válida o de Supabase.
export async function currentUser(writable = true) {
  const secret = demoSecret();
  const value = (await cookies()).get(cookieName)?.value;
  if (value && secret) {
    // Verifica el nombre de la cuenta, la expiración y el formato antes de comparar la firma.
    const [account, expiry, signature] = value.split(".");
    if (Object.hasOwn(demoAccounts, account) && /^\d+$/.test(expiry) &&
        Number(expiry) > Date.now() / 1000 && /^[a-f\d]{64}$/.test(signature)) {
      const expected = createHmac("sha256", secret).update(`${account}.${expiry}`).digest();
      // Compara los bytes de las firmas en tiempo constante.
      if (timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
        return { ...demoAccounts[account as keyof typeof demoAccounts], demo: true };
      }
    }
  }

  // Para una sesión real, Supabase debe confirmar tanto el usuario como su dirección de correo.
  if (!supabaseConfigured()) return null;
  const supabase = await supabaseClient(writable);
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;
  if (error || !user?.email || !user.email_confirmed_at) return null;
  return { id: user.id, email: user.email, demo: false };
}

// Solicita a Supabase un enlace de acceso que volverá a la ruta de confirmación de Pulso.
export async function sendLoginLink(email: string, redirectTo: string) {
  const supabase = await supabaseClient();
  return supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
}

// Canjea el código del enlace por una sesión y aplica las invitaciones del correo verificado.
export async function exchangeLoginCode(code: string) {
  const supabase = await supabaseClient();
  const result = await supabase.auth.exchangeCodeForSession(code);
  if (!result.error && result.data.user.email && result.data.user.email_confirmed_at) {
    const { id, email } = result.data.user;
    await claimInvitations(id, email);
  }
  return result;
}

// Consume las invitaciones y crea las membresías correspondientes en una sola operación de base de datos.
export async function claimInvitations(userId: string, email: string) {
  await transaction(async (client) => {
    // Si la membresía ya existe, conserva su rol y evita insertar una fila duplicada.
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

// Elimina la cookie demo y pide a Supabase que cierre la sesión real cuando está configurado.
export async function logout() {
  (await cookies()).delete(cookieName);
  if (supabaseConfigured()) await (await supabaseClient()).auth.signOut();
}
