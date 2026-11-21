import { redirect } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { currentUser } from "@/lib/auth";
import { AccessDeniedError } from "@/lib/db";
import { readWorkspace } from "@/lib/workspace";

export default async function Home({ searchParams }: { searchParams: Promise<{ company?: string }> }) {
  const user = await currentUser(false);
  if (!user) redirect("/login");

  const { company } = await searchParams;
  try {
    return <Dashboard initial={await readWorkspace(user, company)} />;
  } catch (error) {
    if (error instanceof AccessDeniedError) redirect("/");
    throw error;
  }
}
