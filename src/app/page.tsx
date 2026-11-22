import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { currentUser } from "@/lib/auth";
import { AccessDeniedError } from "@/lib/db";
import { readWorkspace } from "@/lib/workspace";

// Página principal autenticada. Carga la empresa activa antes de enviar el panel al navegador.
export default async function Home({ searchParams }: { searchParams: Promise<{ company?: string }> }) {
  // Lee las cookies y envía al formulario de acceso a quien no tiene sesión.
  const user = await currentUser(false);
  if (!user) redirect("/login");

  // Usa la empresa seleccionada en la URL. Si la membresía no permite acceder, vuelve a la selección predeterminada.
  const { company } = await searchParams;
  try {
    return <Dashboard initial={await readWorkspace(user, company)} />;
  } catch (error) {
    if (error instanceof AccessDeniedError) redirect("/");
    throw error;
  }
}
