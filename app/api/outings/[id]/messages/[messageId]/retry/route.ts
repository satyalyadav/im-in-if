import { retryMessage } from "@/lib/outings-api";
import { requireAgent, requireContext, toResponse } from "@/lib/request-context";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  const agent = requireAgent();
  if (agent instanceof Response) return agent;

  const { id, messageId } = await params;
  return toResponse(await retryMessage({ ...context, agent }, id, messageId));
}
