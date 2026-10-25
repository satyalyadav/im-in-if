import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getOutingWorkspace } from "@/lib/planning-api";
import { OutingWorkspace, type Workspace } from "@/components/outing-workspace";
import { SignInPanel } from "@/components/sign-in-panel";
import { TopBar } from "@/components/top-bar";

export const dynamic = "force-dynamic";

export default async function OutingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();
  if (!userId) {
    return (
      <main className="page">
        <TopBar signedIn={false} />
        <section className="narrow">
          <h1>Sign in to view your outing</h1>
          <SignInPanel returnTo={`/outings/${encodeURIComponent(id)}`} />
        </section>
      </main>
    );
  }

  const result = await getOutingWorkspace({ db: await getDb(), userId }, id);
  if (result.status !== 200) notFound();

  return (
    <main className="page">
      <TopBar signedIn />
      <OutingWorkspace initialWorkspace={result.body as unknown as Workspace} />
    </main>
  );
}
