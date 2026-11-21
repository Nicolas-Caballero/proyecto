import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCompletionForm } from "../../../lib/public";
import { PublicForm } from "../../f/public-form";
import { PublicShell, hasLightBrandColor } from "../../f/public-shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Completar una solicitud",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function CompletionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await getCompletionForm(token);
  if (!data) notFound();
  return (
    <PublicShell brand={data.brand} completion>
      <PublicForm
        kind="completion"
        endpoint={`/api/public/completar/${encodeURIComponent(token)}`}
        fields={data.fields}
        darkText={hasLightBrandColor(data.brand.color)}
      />
    </PublicShell>
  );
}
