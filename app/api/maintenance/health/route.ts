import { getDb } from "@/lib/db";
import { schedulerAuthResponse } from "@/lib/maintenance-auth";
import { getMaintenanceHealth } from "@/lib/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const unauthorized = schedulerAuthResponse(request);
  if (unauthorized) return unauthorized;

  try {
    return Response.json(await getMaintenanceHealth(await getDb()));
  } catch {
    console.error("maintenance health check failed");
    return Response.json({ error: "maintenance_unavailable" }, { status: 503 });
  }
}
