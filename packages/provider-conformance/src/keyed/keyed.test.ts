// The kit on the model adapter interface, run against what the SDK ships: the reference keyed fetch,
// and the Bedrock adapter in a process of its own -- SigV4 signed THERE, checked by the fake.
import { describe, expect, test } from "bun:test";
import { KeyedFetchError, createKeyedFetch, spawnBedrockAdapterProcess, type AdapterContext, type CredentialMaterial, type ProviderEvent } from "@waifucave/clover-provider-runtime";
import { FAKE_ACCESS_KEY_ID, FAKE_REGION, FAKE_SECRET_ACCESS_KEY, eventStreamResponse, startBedrockFake, textTurnFrames } from "../fakes/bedrock.ts";
import { stalledResponse } from "../fakes/server.ts";
import { KEYED_FETCH_CASES, MODEL_ADAPTER_CASES, formatConformanceReport, runKeyedFetchConformance, runModelAdapterConformance } from "./index.ts";

// A shipped Bedrock row, so the process's own catalog lookup finds its descriptor.
const MODEL = "amazon.nova-lite-v1:0";

describe("the keyed fetch conformance cases", () => {
  test("the SDK's reference keyed fetch passes every case", async () => {
    const report = await runKeyedFetchConformance("createKeyedFetch", (config) => createKeyedFetch(config));
    expect(report.outcomes.map((o) => o.id)).toEqual(KEYED_FETCH_CASES.map((c) => c.id));
    if (!report.ok) throw new Error(formatConformanceReport(report, KEYED_FETCH_CASES));
  }, 30_000);

  test("the cases are not vacuous: a fetch that adds no key and follows any redirect fails them", async () => {
    // A fetch with no host rule that follows every redirect -- but only ever on loopback (the tests'
    // network guard refuses anything else): it follows redirects by hand, and a non-loopback URL, first
    // or redirected to, is answered here as if it had been sent.
    const loopback = (url: string): boolean => ["127.0.0.1", "localhost"].includes(new URL(url).hostname);
    const plainFetch = async (url: string, init?: Parameters<typeof fetch>[1], hops = 0): Promise<Response> => {
      if (!loopback(url)) return new Response("sent");
      const res = await fetch(url, { ...(init ?? {}), redirect: "manual" } as RequestInit);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location === null || hops >= 5) return res;
      return plainFetch(new URL(location, url).toString(), init, hops + 1);
    };
    const report = await runKeyedFetchConformance("a plain fetch", (() => (url: string, init?: Parameters<typeof fetch>[1]) => plainFetch(url, init)) as never);
    expect(report.ok).toBe(false);
    const failed = report.outcomes.filter((o) => o.status === "failed").map((o) => o.id);
    expect(failed).toEqual(expect.arrayContaining(["declared-hosts-only", "key-in-placement", "caller-cannot-set-the-key", "redirect-elsewhere-refused", "retry-401-once-with-newer-token", "idle-ends-typed"]));
  }, 30_000);

  test("a fetch that names a refused redirect's target, or takes a request's idle limit unbounded, fails those cases", async () => {
    const report = await runKeyedFetchConformance("an unbounded, target-naming fetch", (config) => async (url, init, options) => {
      // The request's own idle limit becomes the host's, unclamped; redirects come back unfollowed.
      const keyed = createKeyedFetch({ ...config, followRedirects: false, ...(options?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }) });
      const res = await keyed(url, init, options?.auth === undefined ? {} : { auth: options.auth });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location === null) return res;
      const target = new URL(location, url);
      // ...and a hop off the declared hosts is refused BY NAME, as this fetch's first version did.
      if (!config.hosts.includes(target.host)) throw new KeyedFetchError("redirect_refused", `${target.host} is not one of this plugin's network hosts`);
      return keyed(target.toString(), init, options?.auth === undefined ? {} : { auth: options.auth });
    });
    const failed = report.outcomes.filter((o) => o.status === "failed").map((o) => o.id);
    expect(failed).toEqual(expect.arrayContaining(["redirect-elsewhere-refused", "idle-option-bounded"]));
  }, 30_000);
});

describe("Bedrock in a process of its own: SigV4 is signed there, with the secret only that process read", () => {
  test("a turn reaches the fake signed (the fake verifies SigV4), the process asked the host's door for `aws`, and the kit's cases pass", async () => {
    const fake = await startBedrockFake({
      scenarios: {
        [MODEL]: (recorded) => (recorded.body.includes("hold") ? stalledResponse(10_000) : eventStreamResponse(textTurnFrames("hello from bedrock"))),
      },
    });
    const asked: string[] = [];
    const proc = spawnBedrockAdapterProcess({
      hosts: [new URL(fake.url).host],
      secrets: {
        get: async (name): Promise<CredentialMaterial | null> => {
          asked.push(name);
          return name === "aws" ? { kind: "aws", accessKeyId: FAKE_ACCESS_KEY_ID, secretAccessKey: FAKE_SECRET_ACCESS_KEY } : null;
        },
      },
    });
    try {
      const context = (): AdapterContext => ({
        connection: { providerId: "bedrock", region: FAKE_REGION, baseUrl: fake.url, local: true },
        // The host's keyed fetch: an own-process adapter never calls it (its process signs and sends).
        fetch: createKeyedFetch({ hosts: [new URL(fake.url).host] }),
        stallTimeoutMs: 5000,
        log: () => {},
      });
      const events: ProviderEvent[] = [];
      for await (const event of proc.streamTurn({ model: MODEL, messages: [{ role: "user", content: "hi" }] }, context())) events.push(event);
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("hello from bedrock");
      expect(fake.signatures.length).toBeGreaterThan(0);
      expect(fake.signatures.every((s) => s.verified && s.accessKeyId === FAKE_ACCESS_KEY_ID && s.service === "bedrock")).toBe(true);
      expect(asked).toContain("aws");
      // The secret never crossed back: nothing the host side holds or the fake logged carries it.
      expect(JSON.stringify(events)).not.toContain(FAKE_SECRET_ACCESS_KEY);

      const report = await runModelAdapterConformance({
        subject: "bedrock (own process)",
        adapter: proc,
        context,
        turn: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
        holdingTurn: { model: MODEL, messages: [{ role: "user", content: "hold" }] },
        ownProcess: true,
        fakeRequests: () => fake.requests.length,
      });
      expect(report.outcomes.map((o) => o.id)).toEqual(MODEL_ADAPTER_CASES.map((c) => c.id));
      if (!report.ok) throw new Error(formatConformanceReport(report, MODEL_ADAPTER_CASES));
    } finally {
      await proc.close();
      await fake.close();
    }
  }, 60_000);
});
