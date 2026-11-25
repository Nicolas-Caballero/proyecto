import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Next.js ejecuta este paso antes de abrir el panel para validar y renovar la sesión de Supabase.
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // Prepara la respuesta que continúa a la página. En la demo puede no haber un proyecto Supabase configurado.
  let response = NextResponse.next({ request });
  if (!url || !key) return response;

  // Conecta el cliente con las cookies de la petición para que Supabase pueda leer la sesión actual.
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      // Copia las cookies renovadas a la petición que sigue y a la respuesta que recibe el navegador.
      setAll: (entries) => {
        for (const { name, value } of entries) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of entries) response.cookies.set(name, value, options);
      },
    },
  });
  // Consulta la identidad en Supabase y deja que el cliente renueve las cookies si corresponde.
  await supabase.auth.getUser();
  return response;
}

// Limita el proxy a la ruta raíz. Las rutas de la API gestionan su sesión al recibir la petición.
export const config = { matcher: ["/"] };
