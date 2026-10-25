import { getInvitationStatus, requestAdmission } from "@/lib/planning-api";
import { readJson, requireContext, toResponse } from "@/lib/request-context";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  const { token } = await params;
  return toResponse(await getInvitationStatus(context, token));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  const { token } = await params;
  return toResponse(await requestAdmission(context, token, await readJson(request)));
}
