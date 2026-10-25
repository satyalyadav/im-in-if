import { createOuting } from "@/lib/outings-api";
import { readJson, requireContext, toResponse } from "@/lib/request-context";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = await requireContext(request);
  if (context instanceof Response) return context;

  return toResponse(await createOuting(context, await readJson(request)));
}
