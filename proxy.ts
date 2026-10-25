import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const isLocal = process.env.AUTH_MODE === "local";
const clerk = isLocal ? null : clerkMiddleware();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (clerk) return clerk(request, event);

  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    throw new Error("AUTH_MODE=local is development-only");
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
