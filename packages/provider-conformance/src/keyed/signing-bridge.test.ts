// Clover 0.0.65 (A-M2 review B3): an adapter that signs (Bedrock's SigV4) runs its requests over the plugin's
// `net.fetch` (`ctx.fetch`), with no key added, so the plugin's `network:` hosts bound it like any other adapter.
// Before, it used the platform's `fetch` and reached any host.
import { expect, test } from "bun:test";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { createKeyedFetch, familyAdapterById, modelAdapterFromSigningAdapter, type AdapterContext, type CredentialMaterial, type KeyedFetch, type ProviderEvent } from "@waifucave/clover-provider-runtime";
import { FAKE_ACCESS_KEY_ID, FAKE_REGION, FAKE_SECRET_ACCESS_KEY, eventStreamResponse, startBedrockFake, textTurnFrames } from "../fakes/bedrock.ts";

const catalog = loadCatalog();
const secrets = { get: async (name: string): Promise<CredentialMaterial | null> => (name === "aws" ? { kind: "aws", accessKeyId: FAKE_ACCESS_KEY_ID, secretAccessKey: FAKE_SECRET_ACCESS_KEY } : null) };

async function drain(events: AsyncIterable<ProviderEvent>): Promise<string> {
  let out = "";
  for await (const e of events) {
    if (e.type === "error") throw new Error(`${e.error.code}: ${e.error.message}`);
    if (e.type === "text_delta") out += e.text;
  }
  return out;
}

test("a signing adapter's request goes out through ctx.fetch, with auth off, and the host limit there refuses one it didn't declare", async () => {
  const fake = await startBedrockFake({ scenarios: { "amazon.nova-lite-v1:0": [eventStreamResponse(textTurnFrames("signed and fenced"))] } });
  try {
    const adapter = modelAdapterFromSigningAdapter(familyAdapterById(catalog, "winter.bedrock-converse")!, { secret: "aws" });
    const calls: Array<{ url: string; auth: unknown }> = [];
    const through: KeyedFetch = async (url, init, opts) => {
      calls.push({ url, auth: opts?.auth });
      return fetch(url, init as RequestInit);
    };
    const ctx = (fetch: KeyedFetch): AdapterContext => ({ connection: { providerId: "bedrock", region: FAKE_REGION, baseUrl: fake.url, local: true }, fetch, secrets, stallTimeoutMs: 5000, log: () => {} });
    expect(await drain(adapter.streamTurn({ model: "amazon.nova-lite-v1:0", messages: [{ role: "user", content: "hi" }] }, ctx(through)))).toBe("signed and fenced");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url.startsWith(fake.url)).toBe(true);
    expect(calls[0]!.auth).toBe(false);
    // The fake verified the SigV4 signature on what it received.
    expect(fake.requests.length).toBe(1);

    const before = fake.requests.length;
    // The plugin declared only Bedrock's real host: the loopback fake isn't on its list.
    const fenced = createKeyedFetch({ hosts: [`bedrock-runtime.${FAKE_REGION}.amazonaws.com`] });
    const started = Date.now();
    await expect(drain(adapter.streamTurn({ model: "amazon.nova-lite-v1:0", messages: [{ role: "user", content: "hi" }] }, ctx(fenced)))).rejects.toThrow(/host_not_declared/);
    // Refused at once: a host off the list isn't a network failure the retry ladder waits out.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fake.requests.length).toBe(before);
  } finally {
    await fake.close();
  }
}, 30_000);
