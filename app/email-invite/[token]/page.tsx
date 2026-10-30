import { notFound, redirect } from "next/navigation";
import { SignInPanel } from "@/components/sign-in-panel";
import { TopBar } from "@/components/top-bar";
import { getAccountDisplayName, getCurrentUserId, getVerifiedAccountEmails } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { acceptEmailInvitation, getEmailInvitationStatus } from "@/lib/email-invitations";

export const dynamic = "force-dynamic";

export default async function EmailInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const returnTo = `/email-invite/${encodeURIComponent(token)}`;
  const userId = await getCurrentUserId();

  if (!userId) {
    return (
      <main className="page">
        <TopBar signedIn={false} />
        <section className="narrow">
          <p className="playbill-kicker">Private invitation</p>
          <h1>Sign in to continue</h1>
          <p>Use the verified email address that received this invitation.</p>
          <SignInPanel returnTo={returnTo} />
        </section>
      </main>
    );
  }

  const context = {
    db: await getDb(),
    userId,
    verifiedEmails: await getVerifiedAccountEmails(userId),
  };
  const result = await getEmailInvitationStatus(context, token);
  if (result.status === 200 && typeof result.body.outingId === "string") {
    redirect(`/outings/${result.body.outingId}`);
  }
  if (result.status === 404) notFound();

  async function joinPlanningGroup() {
    "use server";

    const currentUserId = await getCurrentUserId();
    if (!currentUserId) redirect(returnTo);
    const accepted = await acceptEmailInvitation({
      db: await getDb(),
      userId: currentUserId,
      verifiedEmails: await getVerifiedAccountEmails(currentUserId),
      displayName: await getAccountDisplayName(currentUserId),
    }, token);
    if (accepted.status === 200 && typeof accepted.body.outingId === "string") {
      redirect(`/outings/${accepted.body.outingId}`);
    }
    redirect(returnTo);
  }

  return (
    <main className="page">
      <TopBar signedIn />
      <section className="narrow">
        <p className="playbill-kicker">Private invitation</p>
        {result.status === 200 ? (
          <>
            <h1>Join this planning group</h1>
            <p>Your email address matches the invitation. Joining does not record interest or confirm attendance.</p>
            <form action={joinPlanningGroup}>
              <button className="button button-solid" type="submit">Join planning group</button>
            </form>
          </>
        ) : (
          <>
            <h1>Email verification needed</h1>
            <p>This account does not have the verified email address required for this invitation.</p>
          </>
        )}
      </section>
    </main>
  );
}
