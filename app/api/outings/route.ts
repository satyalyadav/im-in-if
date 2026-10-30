import { createOuting } from "@/lib/outings-api";
import { readJson, requireAgent, requireContext, toResponse } from "@/lib/request-context";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  const agent = requireAgent();
  return toResponse(await createOuting(
    context,
    await readJson(request),
    agent instanceof Response ? undefined : agent,
  ));
}
