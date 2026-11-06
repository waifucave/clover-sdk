// Clover A-M2: the SDK's family adapters run KEYLESS on the keyed fetch (`modelAdapterFromProviderAdapter`), the way a
// code model plugin runs them in the plugin host, and a host serves such an adapter to a session over the control
// wire (`createHostModelAdapterServer` <-> `hostServedProviderAdapter`). Every case runs against a loopback fake that
// records the RAW credential header it received: the core's key arrives there, where the plugin's manifest put it,
// while the family adapter only ever held a sentinel.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import {
  createHostModelAdapterServer,
  createKeyedFetch,
  familyAdapterById,
  hostModelAdapterOf,
  hostServedProviderAdapter,
  keyedTransport,
  modelAdapterFromProviderAdapter,
  type AdapterContext,
  type KeyPlacement,
  type KeyedFetch,
  type ModelAdapter,
  type ProviderContext,
  type ProviderEvent,
} from "@waifucave/clover-provider-runtime";
import { anthropicFakeRoutes, anthropicTurnResponse } from "../fakes/anthropic-messages.ts";
import { chatStream, chatModelOf } from "../fakes/openai-chat.ts";
import { startFake, stalledResponse, type FakeServer } from "../fakes/server.ts";
import { MODEL_ADAPTER_CASES, formatConformanceReport, runModelAdapterConformance } from "./index.ts";

const KEY = "test-key-not-a-secret-0001";
const catalog = loadCatalog();

/** Raw credential headers, as the fake received them (its own log redacts them). */
interface Seen {
  authorization: string | null;
  xApiKey: string | null;
}

async function chatFake(seen: Seen[]): Promise<FakeServer> {
  const handler = (req: Request, recorded: Parameters<Parameters<typeof startFake>[0]["routes"][number]["handler"]>[1]): Response => {
    seen.push({ authorization: req.headers.get("authorization"), xApiKey: req.headers.get("x-api-key") });
    if (recorded.body.includes("hold")) return stalledResponse(10_000);
    return chatStream({ model: chatModelOf(recorded) ?? "m", text: ["hello ", "from ", "the plugin"], finishReason: "stop", usage: { prompt: 5, completion: 3 } });
  };
  return startFake({ routes: [{ path: "/chat/completions", method: "POST", handler }, { path: "/v1/chat/completions", method: "POST", handler }] });
}

async function anthropicFake(seen: Seen[]): Promise<FakeServer> {
  const routes = anthropicFakeRoutes({ messages: { "claude-fable-5": (recorded) => (recorded.body.includes("hold") ? stalledResponse(10_000) : anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hello from ", "messages"] }], stopReason: "end_turn" })) } });
  return startFake({
    routes: routes.map((r) => ({
      ...r,
      handler: (req, recorded) => {
        seen.push({ authorization: req.headers.get("authorization"), xApiKey: req.headers.get("x-api-key") });
        return r.handler(req, recorded);
      },
    })),
  });
}

function keyed(fake: FakeServer, placement?: KeyPlacement): KeyedFetch {
  return createKeyedFetch({
    hosts: [new URL(fake.url).host],
    auth: { "api-key": { source: { current: async () => ({ value: KEY, generation: 1 }), newer: async () => null }, ...(placement !== undefined ? { placement } : {}) } },
  });
}

async function text(events: AsyncIterable<ProviderEvent>): Promise<string> {
  let out = "";
  for await (const e of events) {
    if (e.type === "error") throw new Error(`${e.error.code}: ${e.error.message}`);
    if (e.type === "text_delta") out += e.text;
  }
  return out;
}

describe("a family adapter, keyless on the keyed fetch", () => {
  test("chat completions: the key reaches the provider as Authorization: Bearer from the core, and the kit's cases pass", async () => {
    const seen: Seen[] = [];
    const fake = await chatFake(seen);
    try {
      const adapter = modelAdapterFromProviderAdapter(familyAdapterById(catalog, "winter.openai-chat-completions"), { auth: { name: "api-key", material: "api-key" } });
      const context = (): AdapterContext => ({ connection: { providerId: "groq", baseUrl: fake.url, local: true }, fetch: keyed(fake), stallTimeoutMs: 5000, log: () => {} });
      expect(await text(adapter.streamTurn({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }] }, context()))).toBe("hello from the plugin");
      expect(seen.at(-1)).toEqual({ authorization: `Bearer ${KEY}`, xApiKey: null });
      const report = await runModelAdapterConformance({
        subject: "chat completions, keyless",
        adapter,
        context,
        turn: { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }] },
        holdingTurn: { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hold" }] },
      });
      expect(report.outcomes.map((o) => o.id)).toEqual(MODEL_ADAPTER_CASES.map((c) => c.id));
      if (!report.ok) throw new Error(formatConformanceReport(report, MODEL_ADAPTER_CASES));
      // Never the sentinel, never twice: every request carried the core's key and nothing else.
      expect(seen.every((s) => s.authorization === `Bearer ${KEY}`)).toBe(true);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("messages: the key goes where the manifest's placement says (x-api-key), not where the family put the sentinel", async () => {
    const seen: Seen[] = [];
    const fake = await anthropicFake(seen);
    try {
      const adapter = modelAdapterFromProviderAdapter(familyAdapterById(catalog, "winter.anthropic-messages"), { auth: { name: "api-key", material: "api-key" } });
      const context = (): AdapterContext => ({ connection: { providerId: "anthropic", baseUrl: fake.url, local: true }, fetch: keyed(fake, { header: "x-api-key" }), stallTimeoutMs: 5000, log: () => {} });
      expect(await text(adapter.streamTurn({ model: "claude-fable-5", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 64 }, context()))).toBe("hello from messages");
      expect(seen.at(-1)).toEqual({ authorization: null, xApiKey: KEY });
      const report = await runModelAdapterConformance({
        subject: "messages, keyless",
        adapter,
        context,
        turn: { model: "claude-fable-5", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 64 },
        holdingTurn: { model: "claude-fable-5", messages: [{ role: "user", content: "hold" }], maxOutputTokens: 64 },
      });
      if (!report.ok) throw new Error(formatConformanceReport(report, MODEL_ADAPTER_CASES));
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("a request that carries the sentinel anywhere but a key header is refused before it is sent", async () => {
    const sent: string[] = [];
    const fetch: KeyedFetch = async (url) => {
      sent.push(url);
      return new Response("ok");
    };
    const transport = keyedTransport(fetch, "clover-keyed-s3ntinel", "api-key");
    await expect(transport("https://api.example/v1?key=clover-keyed-s3ntinel", { method: "GET" })).rejects.toMatchObject({ code: "capability" });
    await expect(transport("https://api.example/v1", { method: "GET", headers: { "x-echo": "clover-keyed-s3ntinel" } })).rejects.toMatchObject({ code: "capability" });
    expect(sent).toEqual([]);
    // In a key header it is taken out, and the request names its auth entry; with none, it names none.
    const named: unknown[] = [];
    const recording: KeyedFetch = async (_url, init, options) => {
      named.push([init?.headers, options]);
      return new Response("ok");
    };
    await keyedTransport(recording, "clover-keyed-s3ntinel", "api-key")("https://api.example/v1", { method: "GET", headers: { authorization: "Bearer clover-keyed-s3ntinel", accept: "x" } });
    await keyedTransport(recording, "clover-keyed-s3ntinel", "api-key")("https://api.example/v1", { method: "GET" });
    expect(named).toEqual([[{ accept: "x" }, { auth: "api-key" }], [{}, { auth: false }]]);
  });
});

describe("an adapter the host serves to a session", () => {
  function served(adapter: ModelAdapter, fetch: KeyedFetch) {
    const server = createHostModelAdapterServer((id) => (id === adapter.id ? hostModelAdapterOf(adapter, () => ({ fetch, log: () => {} })) : undefined));
    const sender = {
      async request<T>(subtype: string, payload: unknown): Promise<T> {
        // Through JSON both ways, as the control wire carries it.
        const answer = await server.handle(subtype, JSON.parse(JSON.stringify(payload)));
        if (!answer.ok) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
        return JSON.parse(JSON.stringify(answer.value)) as T;
      },
    };
    const stub = hostServedProviderAdapter({ id: adapter.id, version: adapter.version, family: adapter.family, protocol: adapter.protocol }, sender);
    return { server, stub };
  }
  const providerContext = (fake: FakeServer): ProviderContext => ({
    connection: { providerId: "groq", baseUrl: fake.url, local: true },
    // The session side holds NO credential for a host-served adapter: a store that has nothing.
    credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
    authRef: { kind: "none" },
    stallTimeoutMs: 5000,
    log: () => {},
  });

  test("a turn streams through the stub, and the key is the host's", async () => {
    const seen: Seen[] = [];
    const fake = await chatFake(seen);
    try {
      const adapter = modelAdapterFromProviderAdapter(familyAdapterById(catalog, "winter.openai-chat-completions"), { auth: { name: "api-key", material: "api-key" }, id: "plugin.acme.adapter" });
      const { server, stub } = served(adapter, keyed(fake));
      expect(await text(stub.streamTurn({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }] }, providerContext(fake)))).toBe("hello from the plugin");
      expect(seen.at(-1)?.authorization).toBe(`Bearer ${KEY}`);
      expect(server.open).toBe(0);
      // The local half answers from the row, synchronously.
      const row = catalog.models.find((m) => m.key === "groq/llama-3.3-70b-versatile")!;
      expect(stub.capabilities(row).toolCalling).toBe(row.toolCalling.value);
      expect(stub.mapEffort(undefined, row)).toEqual({ ok: true, value: undefined });
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("aborting the session's turn cancels the host's call", async () => {
    const seen: Seen[] = [];
    const fake = await chatFake(seen);
    try {
      const adapter = modelAdapterFromProviderAdapter(familyAdapterById(catalog, "winter.openai-chat-completions"), { auth: { name: "api-key", material: "api-key" }, id: "plugin.acme.adapter" });
      const { server, stub } = served(adapter, keyed(fake));
      const controller = new AbortController();
      const started = Date.now();
      const done = text(stub.streamTurn({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hold" }], signal: controller.signal }, providerContext(fake))).catch((e: unknown) => String(e));
      await Bun.sleep(150);
      controller.abort();
      await done;
      expect(Date.now() - started).toBeLessThan(5000);
      for (let i = 0; i < 50 && server.open > 0; i++) await Bun.sleep(10);
      expect(server.open).toBe(0);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("an adapter the host does not serve to this session is refused at open", async () => {
    const server = createHostModelAdapterServer(() => undefined);
    expect(await server.handle("model_adapter_open", { adapterId: "plugin.other.adapter", method: "streamTurn", connection: { providerId: "x" }, stallTimeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: "not_served" } });
    expect(await server.handle("model_adapter_next", { callId: "mac-404" })).toMatchObject({ ok: false, error: { code: "unknown_call" } });
  });
});
