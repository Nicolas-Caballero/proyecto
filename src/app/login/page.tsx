import { Activity, ArrowRight, Building2, Scissors, Wrench } from "lucide-react";
import { demoEnabled, supabaseConfigured } from "@/lib/auth";
import styles from "./login.module.css";

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { sent, error } = await searchParams;
  const demo = demoEnabled();
  const supabase = supabaseConfigured();
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.brand}><span><Activity size={24} /></span>Pulso</div>
        <h1>Tu bandeja de solicitudes</h1>
        <p>Organiza los contactos, las citas y los seguimientos de tu negocio.</p>
        {sent && <div className={styles.notice} role="status">Revisa tu correo para abrir el enlace de acceso.</div>}
        {error && <div className={styles.notice} role="alert">No se pudo iniciar sesión. Comprueba el correo o solicita otro enlace.</div>}
        {supabase && (
          <form action="/api/auth/login" method="post" className={styles.form}>
            <label htmlFor="email">Correo electrónico</label>
            <input id="email" name="email" type="email" autoComplete="email" required placeholder="tu@negocio.es" />
            <button type="submit" className={styles.primary}>Enviar enlace <ArrowRight size={16} /></button>
          </form>
        )}
        {demo && (
          <form action="/api/auth/login" method="post" className={styles.form}>
            <span className={styles.label}>Explorar la demo</span>
            <button type="submit" name="demo" value="admin" className={styles.primary}><Scissors size={17} /> Entrar como administradora <ArrowRight size={16} /></button>
            <button type="submit" name="demo" value="employee"><Building2 size={17} /> Entrar como empleada</button>
            <button type="submit" name="demo" value="workshop"><Wrench size={17} /> Entrar como administrador del taller</button>
          </form>
        )}
        {!demo && !supabase && <p className={styles.notice}>Configura Supabase Auth para habilitar el acceso.</p>}
      </section>
    </main>
  );
}
