import { handlePlanningAction } from "@/lib/planning-api";
import { readJson, requireContext, toResponse } from "@/lib/request-context";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  const { id } = await params;
  return toResponse(await handlePlanningAction(context, id, await readJson(request)));
}
