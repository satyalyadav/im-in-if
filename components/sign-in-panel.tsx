import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { isLocalAuth } from "@/lib/auth";

export function SignInPanel() {
  return (
    <div className="signin-panel">
      <h2>Your agent is waiting.</h2>
      <p>
        Sign in before the private chat. A shared link or a typed name never proves who you
        are.
      </p>
      {isLocalAuth() ? (
        <Link className="button" href="/local-signin">
          Sign in for local development
        </Link>
      ) : (
        <SignInButton mode="modal">
          <button type="button" className="button">
            Sign in
          </button>
        </SignInButton>
      )}
      <p className="fineprint">Sign-in keeps your account. It does not carry over an earlier outing.</p>
    </div>
  );
}
