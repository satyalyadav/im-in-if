import { notFound, redirect } from "next/navigation";
import { InvitationRequestForm } from "@/components/invitation-request-form";
import { SignInPanel } from "@/components/sign-in-panel";
import { TopBar } from "@/components/top-bar";
import { getCurrentUserId, getVerifiedAccountEmails } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getInvitationStatus } from "@/lib/planning-api";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const returnTo = `/invite/${encodeURIComponent(token)}`;
  const userId = await getCurrentUserId();

  if (!userId) {
    return (
      <main className="page">
        <TopBar signedIn={false} />
        <section className="narrow">
          <p className="playbill-kicker">Private invitation</p>
          <h1>Sign in to request admission</h1>
          <SignInPanel returnTo={returnTo} />
        </section>
      </main>
    );
  }

  const result = await getInvitationStatus({ db: await getDb(), userId }, token);
  if (result.status !== 200) notFound();
  if (result.body.status === "admitted" && typeof result.body.outingId === "string") {
    redirect(`/outings/${result.body.outingId}`);
  }
  const status = result.body.status;
  if (status !== "not_requested" && status !== "pending" && status !== "rejected") notFound();

  return (
    <main className="page">
      <TopBar signedIn />
      <section className="narrow">
        <InvitationRequestForm
          token={token}
          initialStatus={status}
          verifiedEmails={await getVerifiedAccountEmails(userId)}
        />
      </section>
    </main>
  );
}
