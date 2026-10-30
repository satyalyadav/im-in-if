import { notFound, redirect } from "next/navigation";
import { SignInPanel } from "@/components/sign-in-panel";
import { TopBar } from "@/components/top-bar";
import { getCurrentUserId, getVerifiedAccountEmails } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { acceptEmailInvitation } from "@/lib/email-invitations";

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
  const result = await acceptEmailInvitation(context, token);
  if (result.status === 200 && typeof result.body.outingId === "string") {
    redirect(`/outings/${result.body.outingId}`);
  }
  if (result.status === 404) notFound();

  return (
    <main className="page">
      <TopBar signedIn />
      <section className="narrow">
        <p className="playbill-kicker">Private invitation</p>
        <h1>Email verification needed</h1>
        <p>This account does not have the verified email address required for this invitation.</p>
      </section>
    </main>
  );
}
