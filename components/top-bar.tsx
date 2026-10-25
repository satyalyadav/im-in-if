import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { isLocalAuth } from "@/lib/auth";
import { LocalSignOut } from "@/components/local-sign-out";

export function TopBar({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="topbar">
      <Link href="/" className="wordmark">
        I&rsquo;m in if<span>…</span>
      </Link>
      {signedIn ? (
        <div className="topbar-user">
          {isLocalAuth() ? <LocalSignOut /> : <UserButton />}
        </div>
      ) : null}
    </header>
  );
}
