import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocalAuth } from "@/lib/auth";
import { LocalSignInForm } from "@/components/local-sign-in-form";
import { TopBar } from "@/components/top-bar";

export const dynamic = "force-dynamic";

function localReturnTo(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate?.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return "/";
  }
  return candidate;
}

export default async function LocalSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  if (!isLocalAuth()) notFound();
  const { next } = await searchParams;
  const returnTo = localReturnTo(next);

  return (
    <main className="page">
      <TopBar signedIn={false} />
      <section className="narrow">
        <h1>Local sign-in</h1>
        <p className="lede">
          This adapter exists only while developing. It sets a cookie for the name you type.
          Production uses Clerk, so a signed-in account is required before any private chat.
        </p>
        <LocalSignInForm returnTo={returnTo} />
        <p className="fineprint">
          <Link href="/">Back to the start</Link>
        </p>
      </section>
    </main>
  );
}
