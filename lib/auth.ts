import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import {
  assertLocalAuthAllowed,
  isLocalAuth,
  LOCAL_USER_COOKIE,
} from "@/lib/auth-mode";

export {
  assertLocalAuthAllowed,
  isLocalAuth,
  isValidLocalUserId,
  LOCAL_USER_COOKIE,
} from "@/lib/auth-mode";

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
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
