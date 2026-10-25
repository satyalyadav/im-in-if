import { timingSafeEqual } from "node:crypto";

export function schedulerAuthorization(request: Request): boolean | null {
  const secret = process.env.SCHEDULER_SECRET;
  if (!secret) return null;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

export function schedulerAuthResponse(request: Request): Response | null {
  const authorized = schedulerAuthorization(request);
  if (authorized === null) {
    return Response.json({ error: "scheduler_unconfigured" }, { status: 503 });
  }
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });
  return null;
}
