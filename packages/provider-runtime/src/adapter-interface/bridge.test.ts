import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMemoryCredentialStore } from "../credentials/memory.ts";
import type { ProviderContext, ProviderEvent } from "../types.ts";
import { modelAdapterFromSigningAdapter, providerAdapterFromModelAdapter } from "./bridge.ts";
import { createProbeAdapter } from "./fixtures/probe-adapter.ts";
import type { AdapterContext } from "./types.ts";

let server: ReturnType<typeof Bun.serve>;
const auths: Array<string | null> = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      auths.push(req.headers.get("authorization"));
      return new Response(`echo:${await req.text()}`);
    },
  });
});
afterAll(() => {
  server.stop(true);
});

const ref = { kind: "keychain", account: "probe:default" } as const;
const contextFor = (over: Partial<ProviderContext> = {}): ProviderContext => ({
  connection: { providerId: "probe", baseUrl: `http://127.0.0.1:${server.port}` },
  credentials: createMemoryCredentialStore([[ref, { kind: "api-key", key: "sk-bridge" }]]),
  authRef: ref,
  stallTimeoutMs: 5000,
  log: () => {},
  ...over,
});
const collect = async (events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> => {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};
const text = (events: ProviderEvent[]): string => events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");

describe("providerAdapterFromModelAdapter: a model adapter in today's runtime", () => {
  const bridged = providerAdapterFromModelAdapter(createProbeAdapter(), { hosts: (connection) => [new URL(connection.baseUrl!).host] });

  test("the runtime's credential store feeds the keyed fetch: the key reaches the wire, and the adapter's context has no store and no secrets", async () => {
    let seenContext: AdapterContext | undefined;
    const inner = createProbeAdapter();
    const spy = providerAdapterFromModelAdapter({ ...inner, streamTurn: (req, ctx) => { seenContext = ctx; return inner.streamTurn(req, ctx); } }, { hosts: (connection) => [new URL(connection.baseUrl!).host] });
    const events = await collect(spy.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "hi" }] }, contextFor()));
    expect(text(events)).toBe("secrets:absent;fetched:200:echo:from-adapter;");
    expect(auths.at(-1)).toBe("Bearer sk-bridge");
    expect(Object.keys(seenContext!).sort()).toEqual(["connection", "fetch", "log", "stallTimeoutMs"]);
  });

  test("a `none` reference sends no key; identity and the pure methods pass through", async () => {
    await collect(bridged.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "hi" }] }, contextFor({ authRef: { kind: "none" } })));
    expect(auths.at(-1)).toBeNull();
    expect([bridged.id, bridged.version, bridged.family, bridged.protocol]).toEqual(["probe", "1.0.0", "custom", "openai-chat-completions"]);
    expect(bridged.countTokens).toBeUndefined();
  });

  test("a host the plugin did not declare is refused through the bridge too", async () => {
    const narrow = providerAdapterFromModelAdapter(createProbeAdapter(), { hosts: () => ["api.example.com"] });
    await expect(collect(narrow.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "hi" }] }, contextFor()))).rejects.toMatchObject({ code: "host_not_declared" });
  });
});

describe("modelAdapterFromSigningAdapter: an adapter that signs runs only where secrets exist", () => {
  test("handed a context without `secrets` (a worker's), it refuses typed before anything is sent", async () => {
    const before = auths.length;
    const signing = modelAdapterFromSigningAdapter(providerAdapterFromModelAdapter(createProbeAdapter(), { hosts: () => [`127.0.0.1:${server.port}`] }), { secret: "demo" });
    const ctx: AdapterContext = { connection: { providerId: "probe", baseUrl: `http://127.0.0.1:${server.port}` }, fetch: async () => new Response(""), stallTimeoutMs: 5000, log: () => {} };
    expect(() => signing.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "hi" }] }, ctx)).toThrow(/process of its own/);
    expect(auths.length).toBe(before);
  });
});
