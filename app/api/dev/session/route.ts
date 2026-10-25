import { NextResponse } from "next/server";
import {
  assertLocalAuthAllowed,
  isLocalAuth,
  isValidLocalUserId,
  LOCAL_USER_COOKIE,
} from "@/lib/auth";

export const runtime = "nodejs";

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};

export async function POST(request: Request) {
  if (!isLocalAuth()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  assertLocalAuthAllowed();

  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  if (typeof body?.userId !== "string" || !isValidLocalUserId(body.userId)) {
    return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  }

  const response = NextResponse.json({ userId: body.userId });
  response.cookies.set({ ...COOKIE_OPTIONS, name: LOCAL_USER_COOKIE, value: body.userId });
  return response;
}

export async function DELETE() {
  if (!isLocalAuth()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  assertLocalAuthAllowed();

  const response = NextResponse.json({ ok: true });
  response.cookies.set({ ...COOKIE_OPTIONS, name: LOCAL_USER_COOKIE, value: "", maxAge: 0 });
  return response;
}
