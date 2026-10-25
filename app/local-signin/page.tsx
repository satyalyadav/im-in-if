import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocalAuth } from "@/lib/auth";
import { LocalSignInForm } from "@/components/local-sign-in-form";
import { TopBar } from "@/components/top-bar";

export const dynamic = "force-dynamic";

export default function LocalSignInPage() {
  if (!isLocalAuth()) notFound();

  return (
    <main className="page">
      <TopBar signedIn={false} />
      <section className="narrow">
        <h1>Local sign-in</h1>
        <p className="lede">
          This adapter exists only while developing. It sets a cookie for the name you type.
          Production uses Clerk, so a signed-in account is required before any private chat.
        </p>
        <LocalSignInForm />
        <p className="fineprint">
          <Link href="/">Back to the start</Link>
        </p>
      </section>
    </main>
  );
}
