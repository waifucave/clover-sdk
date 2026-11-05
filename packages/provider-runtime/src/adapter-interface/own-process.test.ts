import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { CredentialMaterial, ProviderEvent } from "../types.ts";
import { createProbeAdapter } from "./fixtures/probe-adapter.ts";
import { spawnModelAdapterProcess, type ModelAdapterProcess } from "./own-process.ts";
import type { AdapterContext } from "./types.ts";

const PROBE_PROCESS = fileURLToPath(new URL("./fixtures/probe-process.ts", import.meta.url));
const DYING_PROCESS = fileURLToPath(new URL("./fixtures/dying-process.ts", import.meta.url));
let server: ReturnType<typeof Bun.serve>;
let outside: ReturnType<typeof Bun.serve>;
let outsideHits = 0;
const asked: string[] = [];
let proc: ModelAdapterProcess;

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => new Response(`echo:${await req.text()}`) });
  outside = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { outsideHits += 1; return new Response("outside"); } });
  const local = createProbeAdapter();
  proc = spawnModelAdapterProcess({
    command: [process.execPath, PROBE_PROCESS],
    local,
    hosts: [`127.0.0.1:${server.port}`],
    secrets: {
      get: async (name): Promise<CredentialMaterial | null> => {
        asked.push(name);
        return name === "demo" ? { kind: "api-key", key: "sk-own-process" } : null;
      },
    },
  });
});
afterAll(async () => {
  await proc.close();
  server.stop(true);
  outside.stop(true);
});

const ctx = (): AdapterContext => ({
  connection: { providerId: "probe", baseUrl: `http://127.0.0.1:${server.port}`, headers: { "x-other": `http://127.0.0.1:${outside.port}` } },
  // The host's own keyed fetch is never used by an adapter in its own process: it fetches for itself.
  fetch: async () => {
    throw new Error("the host's fetch must not be called for an own-process adapter");
  },
  stallTimeoutMs: 5000,
  log: () => {},
});
const collect = async (events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> => {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};
const text = (events: ProviderEvent[]): string => events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");

describe("a model adapter in a process of its own (spec §5.2)", () => {
  test("a turn streams back over the pipe; the process read its secret through the host's door and fetched for itself", async () => {
    const events = await collect(proc.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "hi" }] }, ctx()));
    expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "text_delta", "usage", "done"]);
    // `api-key` is the KIND the process saw; the value stays in the process.
    expect(text(events)).toBe("secrets:api-key;fetched:200:echo:from-adapter;");
    expect(asked).toContain("demo");
    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.pid).not.toBe(process.pid);
  });

  test("the process reaches only the plugin's hosts, even through `fetch` itself", async () => {
    const events = await collect(proc.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "escape" }] }, ctx()));
    expect(text(events)).toContain("refused:host_not_declared");
    expect(outsideHits).toBe(0);
  });

  test("the caller's abort cancels the process's turn", async () => {
    const controller = new AbortController();
    const iterator = proc.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "stall" }], signal: controller.signal }, ctx())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "message_start" });
    controller.abort();
    // The caller is answered at once (the child is told to cancel too).
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
  });

  test("the other calls cross too, and the pure half answers here", async () => {
    expect(await proc.validateCredential(ctx())).toEqual({ ok: true });
    expect((await proc.listModels({ ...ctx(), limits: { maxBytes: 1024, maxItems: 10, timeoutMs: 1000 } })).models).toEqual([{ id: "probe-1" }]);
    expect(proc.capabilities({} as never)).toEqual({ toolCalling: "none", readableState: "none" });
    expect(proc.countTokens).toBeUndefined();
    expect([proc.interfaceVersion, proc.id, proc.family]).toEqual([1, "probe", "custom"]);
  });

  test("a process that is gone fails a call as a retryable network error", async () => {
    const short = spawnModelAdapterProcess({ command: [process.execPath, PROBE_PROCESS], local: createProbeAdapter(), hosts: [], secrets: { get: async () => null } });
    await short.close();
    await expect(collect(short.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "hi" }] }, ctx()))).rejects.toMatchObject({ code: "network", retryable: true });
  });

  test("S1: the process presents the identity its host sends in init", async () => {
    const identity = { product: "probe-host", codexOriginator: "probe-host", contactUrl: "https://example.test/contact", version: "7.7.7" };
    const own = spawnModelAdapterProcess({ command: [process.execPath, PROBE_PROCESS], local: createProbeAdapter(), hosts: [], secrets: { get: async () => null }, identity });
    try {
      const events = await collect(own.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "identity" }] }, ctx()));
      expect(text(events)).toBe("ua:probe-host/7.7.7");
    } finally {
      await own.close();
    }
  });

  test("S5: a process that dies before it is ready fails every call at once, not retryable, with its stderr; `exited` says so", async () => {
    const dying = spawnModelAdapterProcess({ command: [process.execPath, DYING_PROCESS], local: createProbeAdapter(), hosts: [], secrets: { get: async () => null } });
    const err = await collect(dying.streamTurn({ model: "probe-1", messages: [{ role: "user", content: "hi" }] }, ctx())).then(() => undefined, (e: unknown) => e as { code: string; retryable: boolean; message: string });
    expect(err).toMatchObject({ code: "capability", retryable: false });
    expect(err?.message).toContain("a module is missing");
    expect(await dying.exited).toMatchObject({ code: 3, beforeReady: true });
    expect((await dying.exited).stderrTail.join("\n")).toContain("a module is missing");
  });

  test("S5: a call with no signal of its own (validateCredential) ends at its deadline on a hung process", async () => {
    const own = spawnModelAdapterProcess({ command: [process.execPath, PROBE_PROCESS], local: createProbeAdapter(), hosts: [], secrets: { get: async () => null }, callDeadlineMs: 300 });
    try {
      const started = Date.now();
      await expect(own.validateCredential({ ...ctx(), connection: { ...ctx().connection, headers: { "x-hang": "1" } } })).rejects.toMatchObject({ code: "timeout" });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await own.close();
    }
    expect(await own.exited).toMatchObject({ beforeReady: false });
  });
});
