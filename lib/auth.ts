import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";

export const LOCAL_USER_COOKIE = "im_in_if_local_user";

export function isLocalAuth(): boolean {
  return process.env.AUTH_MODE === "local";
}

export function assertLocalAuthAllowed(): void {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    throw new Error("AUTH_MODE=local is development-only");
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function isValidLocalUserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,64}$/.test(value);
}

export async function getRequestUserId(request: Request): Promise<string | null> {
  if (isLocalAuth()) {
    assertLocalAuthAllowed();
    return readCookie(request.headers.get("cookie"), LOCAL_USER_COOKIE);
  }

  const { userId } = await auth();
  return userId ?? null;
}

export async function getCurrentUserId(): Promise<string | null> {
  if (isLocalAuth()) {
    assertLocalAuthAllowed();
    return (await cookies()).get(LOCAL_USER_COOKIE)?.value ?? null;
  }

  const { userId } = await auth();
  return userId ?? null;
}
