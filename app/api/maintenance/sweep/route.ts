import { getDb } from "@/lib/db";
import { schedulerAuthResponse } from "@/lib/maintenance-auth";
import { sweepDueWork } from "@/lib/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const unauthorized = schedulerAuthResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await sweepDueWork(await getDb());
    return result
      ? Response.json({ ok: true, ...result })
      : Response.json({ ok: true, skipped: "already_running" });
  } catch {
    console.error("scheduled maintenance failed");
    return Response.json({ error: "maintenance_failed" }, { status: 500 });
  }
}
