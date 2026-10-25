import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { assertLocalAuthAllowed, isLocalAuth } from "@/lib/auth-mode";

const isLocal = isLocalAuth();
const clerk = isLocal ? null : clerkMiddleware();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (clerk) return clerk(request, event);

  assertLocalAuthAllowed();
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
