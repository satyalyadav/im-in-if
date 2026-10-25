import { getAgent, type Agent } from "@/lib/agent";
import { getRequestUserId, getVerifiedAccountEmails } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { ApiResponse, OwnerContext } from "@/lib/outings-api";

export async function requireContext(request: Request): Promise<OwnerContext | Response> {
  const userId = await getRequestUserId(request);
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const [db, verifiedEmails] = await Promise.all([
    getDb(),
    getVerifiedAccountEmails(userId),
  ]);
  return { userId, db, verifiedEmails };
}

export function requireAgent(): Agent | Response {
  try {
    return getAgent();
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}

export function toResponse(result: ApiResponse): Response {
  return Response.json(result.body, { status: result.status });
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
