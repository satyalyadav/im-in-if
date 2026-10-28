"use client";

import { useEffect, useRef } from "react";

type Variant = "A" | "B" | "C";

export function AgentChatPrototype({ initialVariant }: { initialVariant: Variant }) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) {
        return;
      }

      const message = event.data as { type?: unknown; variant?: unknown } | null;
      if (
        !message ||
        message.type !== "agent-chat-prototype:variant" ||
        (message.variant !== "A" && message.variant !== "B" && message.variant !== "C")
      ) {
        return;
      }

      const url = new URL(window.location.href);
      url.searchParams.set("variant", message.variant);
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frameRef}
      title="I'm in if... agent chat prototype"
      src={"/prototypes/agent-chat.html?variant=" + initialVariant}
      style={{ display: "block", width: "100%", height: "1100px", border: 0 }}
    />
  );
}
