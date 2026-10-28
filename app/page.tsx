import { getCurrentUserId } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listOutings, type OutingView } from "@/lib/outings-api";
import { OutingList } from "@/components/outing-list";
import { SignInPanel } from "@/components/sign-in-panel";
import { StartOutingForm } from "@/components/start-outing-form";
import { TopBar } from "@/components/top-bar";
import { AgentChatPrototype } from "@/components/agent-chat-prototype";

export const dynamic = "force-dynamic";

type HomePageProps = {
  searchParams: Promise<{
    prototype?: string | string[];
    variant?: string | string[];
  }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const query = await searchParams;
  if (process.env.NODE_ENV !== "production" && query.prototype === "agent-chat") {
    const requestedVariant = Array.isArray(query.variant) ? query.variant[0] : query.variant;
    const initialVariant = requestedVariant === "B" || requestedVariant === "C" ? requestedVariant : "A";
    return <AgentChatPrototype initialVariant={initialVariant} />;
  }

  const userId = await getCurrentUserId();
  let outings: OutingView[] = [];

  if (userId) {
    outings = await listOutings({ db: await getDb(), userId });
  }

  return (
    <main className="page">
      <TopBar signedIn={Boolean(userId)} />

      <section className="hero">
        <div className="hero-copy">
          <h1>
            Start before
            <br />
            <em>the plan exists.</em>
          </h1>
          <p className="lede">
            A private agent for the idea you only half said out loud. Set the moment replies
            stop counting, then work out the rest one message at a time.
          </p>
          <p className="hero-note">
            For one movie night, dinner, or campus plan at a time. Your agent works for you,
            not the group chat.
          </p>
        </div>

        <div className="hero-action">{userId ? <StartOutingForm /> : <SignInPanel />}</div>
      </section>

      {outings.length > 0 ? <OutingList outings={outings} /> : null}

      <footer className="page-foot">
        <p>
          Private chats are scoped to one outing. Signing in again does not bring back an
          earlier outing&rsquo;s conditions or agent memory.
        </p>
      </footer>
    </main>
  );
}
