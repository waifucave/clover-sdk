// 2026-11-18: a provider row's `conversationIdHeader` names a request header that carries the
// conversation's stable id. Every adapter that builds a turn's headers sends the turn's cache key in it,
// and sends nothing for a row that names none or a turn that has no key. Driven offline: `fetch` records
// the headers and answers 400, so no model is called.
import { afterEach, describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { createShippedAdapters } from "./index.ts";
import { foldProviderStream } from "../stream-assembler.ts";
import { testContext } from "./openai/testing.ts";
import type { TurnRequest } from "../types.ts";

const catalog = loadCatalog();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function recordHeaders(): Array<Record<string, string>> {
  const original = globalThis.fetch;
  const seen: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return seen;
}

async function send(adapterId: string, providerId: string, model: string, over: Partial<TurnRequest>): Promise<void> {
  const adapter = createShippedAdapters(catalog).find((a) => a.id === adapterId)!;
  await foldProviderStream(adapter.streamTurn({ model, messages: [{ role: "user", content: "hi" }], ...over }, testContext({ providerId }))).catch(() => undefined);
}

describe("conversationIdHeader", () => {
  test("the two OpenCode Go providers name x-opencode-session; no other provider does", () => {
    const named = catalog.providers.filter((p) => p.conversationIdHeader !== undefined).map((p) => [p.id, p.conversationIdHeader]);
    expect(named).toEqual([["opencode-go", "x-opencode-session"], ["opencode-go-anthropic", "x-opencode-session"]]);
  });

  test("Chat Completions: the cache key rides in x-opencode-session beside the runtime's own user agent", async () => {
    const seen = recordHeaders();
    await send("winter.openai-chat-completions", "opencode-go", "kimi-k3.1-pro", { cacheKey: "session-1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["x-opencode-session"]).toBe("session-1");
    expect(seen[0]!["user-agent"]).toMatch(/^[^/\s]+\/\S+/);
  });

  test("Anthropic Messages: the same header on the Anthropic-dialect provider", async () => {
    const seen = recordHeaders();
    await send("winter.anthropic-messages", "opencode-go-anthropic", "qwen4-max", { cacheKey: "session-2:agent-9" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!["x-opencode-session"]).toBe("session-2:agent-9");
  });

  test("no cache key, no header; a provider that names none never sends one", async () => {
    const seen = recordHeaders();
    await send("winter.openai-chat-completions", "opencode-go", "kimi-k3.1-pro", {});
    await send("winter.openai-chat-completions", "openrouter", "deepseek/deepseek-v4.1-flash", { cacheKey: "session-3" });
    await send("winter.anthropic-messages", "anthropic", "claude-sonnet-5-5", { cacheKey: "session-3" });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const h of seen) expect("x-opencode-session" in h).toBe(false);
  });
});
