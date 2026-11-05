// The kit on the model adapter interface, run against what the SDK ships: the reference keyed fetch,
// and the Bedrock adapter in a process of its own -- SigV4 signed THERE, checked by the fake.
import { describe, expect, test } from "bun:test";
import { createKeyedFetch, spawnBedrockAdapterProcess, type AdapterContext, type CredentialMaterial, type ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
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
    // Loopback only (the tests' network guard refuses anything else): a non-loopback URL is answered
    // locally, as a fetch with no host rule would have sent it.
    const plain = () => (url: string, init?: Parameters<typeof fetch>[1]) => (new URL(url).hostname === "127.0.0.1" || new URL(url).hostname === "localhost" ? fetch(url, { ...(init ?? {}) } as RequestInit) : Promise.resolve(new Response("sent")));
    const report = await runKeyedFetchConformance("a plain fetch", plain as never);
    expect(report.ok).toBe(false);
    const failed = report.outcomes.filter((o) => o.status === "failed").map((o) => o.id);
    expect(failed).toEqual(expect.arrayContaining(["declared-hosts-only", "key-in-placement", "caller-cannot-set-the-key", "redirect-elsewhere-refused", "retry-401-once-with-newer-token", "idle-ends-typed"]));
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
