import { getOutingWorkspace } from "@/lib/planning-api";
import { requireContext, toResponse } from "@/lib/request-context";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  const { id } = await params;
  return toResponse(await getOutingWorkspace(context, id));
}
