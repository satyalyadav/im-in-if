import { sendMessage } from "@/lib/outings-api";
import { readJson, requireAgent, requireContext, toResponse } from "@/lib/request-context";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  const agent = requireAgent();
  if (agent instanceof Response) return agent;

  const { id } = await params;
  return toResponse(await sendMessage({ ...context, agent }, id, await readJson(request)));
}
