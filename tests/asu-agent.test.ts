import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, createAsuAgent } from "@/lib/agent";

type Captured = {
  body: Record<string, unknown>;
  authorization: string | undefined;
};

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

const servers: Server[] = [];

async function fakeAsu(handler: Handler): Promise<{ baseURL: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      captured.push({
        body: JSON.parse(body) as Record<string, unknown>,
        authorization: request.headers.authorization,
      });
      handler(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, captured };
}

function completion(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const outing = {
  suggestion: "Dinner Friday?",
  cutoffAt: "2026-11-01T02:30:00.000Z",
  cutoffTimeZone: "America/Phoenix",
};

describe("ASU agent boundary", () => {
  it("sends only this outing's private context to the configured model", async () => {
    const { baseURL, captured } = await fakeAsu((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion("A 7pm show keeps the evening short."));
    });
    const agent = createAsuAgent({
      baseURL,
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5_000,
    });

    const result = await agent.reply({
      outing,
      history: [
        { role: "user", content: "Something cheap near campus." },
        { role: "agent", content: "A matinee is usually cheaper." },
        { role: "user", content: "Friday after 6 works." },
      ],
    });

    expect(result.text).toBe("A 7pm show keeps the evening short.");
    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe("Bearer test-key");
    expect(captured[0].body.model).toBe("test-model");

    const payload = JSON.stringify(captured[0].body);
    expect(payload).toContain("Dinner Friday?");
    expect(payload).toContain("Friday after 6 works.");
    expect(payload).toContain("matinee");
    expect(payload).not.toContain("OTHER-OUTING");
    expect(payload).not.toContain("PRIVATE-BUDGET");
  });

  it("reports a provider failure without echoing private content", async () => {
    const { baseURL } = await fakeAsu((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "upstream exploded" } }));
    });
    const agent = createAsuAgent({
      baseURL,
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5_000,
    });

    const failure = agent.reply({
      outing,
      history: [{ role: "user", content: "PRIVATE-DETAIL-77" }],
    });

    await expect(failure).rejects.toMatchObject({ code: "model_error" });
    await expect(failure).rejects.not.toThrow(/PRIVATE-DETAIL-77/);
  });

  it("times out a delayed model request instead of hanging the chat", async () => {
    const { baseURL } = await fakeAsu(() => {
      // Deliberately never respond.
    });
    const agent = createAsuAgent({
      baseURL,
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 150,
    });

    const started = Date.now();
    await expect(
      agent.reply({ outing, history: [{ role: "user", content: "Still there?" }] }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("treats an empty model reply as a failure rather than saving a blank message", async () => {
    const { baseURL } = await fakeAsu((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion("   "));
    });
    const agent = createAsuAgent({
      baseURL,
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5_000,
    });

    await expect(
      agent.reply({ outing, history: [{ role: "user", content: "Hello?" }] }),
    ).rejects.toBeInstanceOf(AgentError);
    await expect(
      agent.reply({ outing, history: [{ role: "user", content: "Hello?" }] }),
    ).rejects.toMatchObject({ code: "empty_reply" });
  });
});
