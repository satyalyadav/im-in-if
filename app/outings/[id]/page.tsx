import { notFound, redirect } from "next/navigation";
import { getCurrentUserId } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getOuting, type MessageView, type OutingView } from "@/lib/outings-api";
import { OutingChat } from "@/components/outing-chat";
import { TopBar } from "@/components/top-bar";

export const dynamic = "force-dynamic";

export default async function OutingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/");

  const { id } = await params;
  const result = await getOuting({ db: await getDb(), userId }, id);
  if (result.status !== 200) notFound();

  return (
    <main className="page">
      <TopBar signedIn />
      <OutingChat
        outing={result.body.outing as OutingView}
        initialMessages={result.body.messages as MessageView[]}
      />
    </main>
  );
}
