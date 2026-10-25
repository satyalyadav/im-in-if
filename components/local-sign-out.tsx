"use client";

export function LocalSignOut() {
  async function signOut() {
    await fetch("/api/dev/session", { method: "DELETE" });
    window.location.assign("/");
  }

  return (
    <button type="button" className="text-button" onClick={signOut}>
      Sign out
    </button>
  );
}
