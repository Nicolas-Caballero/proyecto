import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicForm, normalizeSource } from "../../../lib/public";
import { PublicForm } from "../public-form";
import { PublicShell, hasLightBrandColor } from "../public-shell";

// La configuración se lee al abrir el formulario para mostrar los últimos cambios.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Enviar una solicitud",
};

// Carga la empresa del slug y convierte la etiqueta del enlace en el origen de la solicitud.
export default async function IntakePage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ origen?: string | string[]; utm_source?: string | string[] }>;
}) {
  const { slug } = await params;
  const [data, query] = await Promise.all([getPublicForm(slug), searchParams]);
  if (!data) notFound();
  return (
    <PublicShell brand={data.brand}>
      <PublicForm
        kind="intake"
        endpoint={`/api/public/f/${encodeURIComponent(slug)}`}
        fields={data.fields}
        services={data.services}
        source={normalizeSource(query.origen ?? query.utm_source)}
        darkText={hasLightBrandColor(data.brand.color)}
      />
    </PublicShell>
  );
}
