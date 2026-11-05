import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyedFetchError, createKeyedFetch, type KeyedAuthEntry, type KeyedTokenSource } from "./keyed-fetch.ts";
import { hostAllowed, parseNetworkHost } from "./network-hosts.ts";
import { tokenSourceFromCredentialStore } from "./token-source.ts";
import { createMemoryCredentialStore } from "../credentials/memory.ts";
import type { CredentialMaterial, CredentialStore } from "../types.ts";

// One loopback server, two "hosts": 127.0.0.1:<port> and localhost:<port> are different origins.
interface Seen {
  path: string;
  headers: Record<string, string>;
  body: string;
}
const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let base: string;
let other: string;
let tokenGeneration = 1;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, headers: Object.fromEntries(req.headers.entries()), body: await req.text() });
      switch (url.pathname) {
        case "/ok":
          return new Response("hello");
        case "/echo-key": {
          const sent = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
          return new Response("echoed", { headers: { "x-echo": `got ${sent}`, "access-control-allow-origin": sent, "x-request-uri": `/v1?key=${encodeURIComponent(sent)}`, "x-plain": "kept" } });
        }
        case "/redirect-same":
          return new Response(null, { status: 302, headers: { location: "/ok" } });
        case "/redirect-other":
          return new Response(null, { status: 307, headers: { location: `${other}/ok` } });
        case "/redirect-away":
          return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/ok" } });
        case "/redirect-303":
          return new Response(null, { status: 303, headers: { location: "/ok" } });
        case "/needs-new-token":
          return req.headers.get("authorization") === `Bearer token-${tokenGeneration}` && tokenGeneration > 1 ? new Response("fresh") : new Response("expired", { status: 401 });
        case "/always-401":
          return new Response("no", { status: 401 });
        case "/slow-stream": {
          // Three chunks, 120 ms apart: longer in total than the idle limit the test sets, never silent that long.
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const part of ["a", "b", "c"]) {
                controller.enqueue(new TextEncoder().encode(part));
                await Bun.sleep(120);
              }
              controller.close();
            },
          });
          return new Response(stream);
        }
        case "/stall": {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              // ...and then nothing, ever.
            },
          });
          return new Response(stream);
        }
        default:
          return new Response("missing", { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  other = `http://localhost:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

const fixed = (value: string): KeyedAuthEntry => ({ source: { current: async () => ({ value, generation: 1 }), newer: async () => null } });
const hostsFor = (): string[] => [`127.0.0.1:${server.port}`];

describe("network hosts", () => {
  test("the grammar: a name, a name with a port, `*.` and a domain, an IPv6 literal; anything else is refused", () => {
    expect(parseNetworkHost("api.example.com")).toEqual({ host: "api.example.com", wildcard: false });
    expect(parseNetworkHost("LocalHost:11434")).toEqual({ host: "localhost", wildcard: false, port: 11434 });
    expect(parseNetworkHost("*.amazonaws.com")).toEqual({ host: "amazonaws.com", wildcard: true });
    expect(parseNetworkHost("[::1]:8080")).toEqual({ host: "::1", wildcard: false, port: 8080 });
    for (const bad of ["", "https://api.example.com", "api.example.com/v1", "*.*.example.com", "host:0", "host:99999", "exa mple.com", "*.[::1]", "*.com", "*.1", "*.0.1", "*.localhost"]) {
      expect(typeof parseNetworkHost(bad)).toBe("string");
    }
  });

  test("a name matches only its own host on the default port; a wildcard only subdomains, never the domain itself", () => {
    const hosts = [parseNetworkHost("api.example.com"), parseNetworkHost("*.amazonaws.com"), parseNetworkHost("localhost:11434")] as Array<Exclude<ReturnType<typeof parseNetworkHost>, string>>;
    expect(hostAllowed(new URL("https://api.example.com/v1"), hosts)).toBe(true);
    expect(hostAllowed(new URL("https://api.example.com:8443/v1"), hosts)).toBe(false);
    expect(hostAllowed(new URL("https://evil-api.example.com/"), hosts)).toBe(false);
    expect(hostAllowed(new URL("https://bedrock-runtime.us-east-1.amazonaws.com/"), hosts)).toBe(true);
    expect(hostAllowed(new URL("https://amazonaws.com/"), hosts)).toBe(false);
    expect(hostAllowed(new URL("https://amazonaws.com.evil.example/"), hosts)).toBe(false);
    expect(hostAllowed(new URL("http://localhost:11434/api"), hosts)).toBe(true);
    expect(hostAllowed(new URL("http://localhost:11435/api"), hosts)).toBe(false);
  });

  test("a config naming a bad host is refused when the fetch is built", () => {
    expect(() => createKeyedFetch({ hosts: ["https://api.example.com"] })).toThrow(TypeError);
  });
});

describe("the keyed fetch (spec §5.4)", () => {
  test("adds the auth entry's key where the adapter says, and the adapter's own request never held it", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor(), auth: { openai: fixed("sk-test-1"), anthropic: { ...fixed("sk-test-1"), placement: { header: "x-api-key" } } } });
    const res = await keyed(`${base}/ok`, {}, { auth: "openai" });
    expect(await res.text()).toBe("hello");
    expect(seen.at(-1)?.headers["authorization"]).toBe("Bearer sk-test-1");
    await keyed(`${base}/ok`, { headers: { "anthropic-version": "2023-06-01" } }, { auth: "anthropic" });
    expect(seen.at(-1)?.headers["x-api-key"]).toBe("sk-test-1");
    expect(seen.at(-1)?.headers["authorization"]).toBeUndefined();
    expect(seen.at(-1)?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("an undeclared host, a plain-http host that is not loopback and user info are refused before anything is sent", async () => {
    const keyed = createKeyedFetch({ hosts: [...hostsFor(), "api.example.com"], auth: { a: fixed("k") } });
    const before = seen.length;
    await expect(keyed(`${other}/ok`)).rejects.toMatchObject({ code: "host_not_declared" });
    await expect(keyed("http://api.example.com/v1")).rejects.toMatchObject({ code: "insecure_url" });
    await expect(keyed(`http://user:pass@127.0.0.1:${server.port}/ok`)).rejects.toMatchObject({ code: "insecure_url" });
    expect(seen.length).toBe(before);
  });

  test("auth entries: the only one by default, one by name, none with `auth: false`; several without a name is refused", async () => {
    const one = createKeyedFetch({ hosts: hostsFor(), auth: { only: fixed("k-only") } });
    await one(`${base}/ok`);
    expect(seen.at(-1)?.headers["authorization"]).toBe("Bearer k-only");
    await one(`${base}/ok`, {}, { auth: false });
    expect(seen.at(-1)?.headers["authorization"]).toBeUndefined();
    const two = createKeyedFetch({ hosts: hostsFor(), auth: { a: fixed("k-a"), b: fixed("k-b") } });
    await expect(two(`${base}/ok`)).rejects.toMatchObject({ code: "ambiguous_auth" });
    await two(`${base}/ok`, {}, { auth: "b" });
    expect(seen.at(-1)?.headers["authorization"]).toBe("Bearer k-b");
    await expect(two(`${base}/ok`, {}, { auth: "c" })).rejects.toMatchObject({ code: "unknown_auth" });
    const none = createKeyedFetch({ hosts: hostsFor() });
    await none(`${base}/ok`);
    expect(seen.at(-1)?.headers["authorization"]).toBeUndefined();
  });

  test("a caller that sets the key's header itself is refused; an entry with nothing stored is refused typed", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor(), auth: { a: fixed("k") } });
    await expect(keyed(`${base}/ok`, { headers: { Authorization: "Bearer guessed" } })).rejects.toMatchObject({ code: "credential_header" });
    const empty = createKeyedFetch({ hosts: hostsFor(), auth: { a: { source: { current: async () => null, newer: async () => null } } } });
    await expect(empty(`${base}/ok`)).rejects.toMatchObject({ code: "no_credential" });
  });

  test("redirects: same origin keeps the key, another declared origin drops it, an undeclared one is refused, 303 becomes a GET", async () => {
    const keyed = createKeyedFetch({ hosts: [...hostsFor(), `localhost:${server.port}`], auth: { a: fixed("k-redirect") } });
    await keyed(`${base}/redirect-same`);
    expect(seen.at(-1)).toMatchObject({ path: "/ok" });
    expect(seen.at(-1)?.headers["authorization"]).toBe("Bearer k-redirect");
    await keyed(`${base}/redirect-other`, { method: "POST", body: "payload" });
    expect(seen.at(-1)?.path).toBe("/ok");
    expect(seen.at(-1)?.headers["host"]).toBe(`localhost:${server.port}`);
    expect(seen.at(-1)?.headers["authorization"]).toBeUndefined();
    expect(seen.at(-1)?.body).toBe("payload");
    await expect(keyed(`${base}/redirect-away`)).rejects.toMatchObject({ code: "redirect_refused" });
    await keyed(`${base}/redirect-303`, { method: "POST", body: "x", headers: { "content-type": "text/plain" } });
    expect(seen.at(-1)).toMatchObject({ path: "/ok", body: "" });
    expect(seen.at(-1)?.headers["content-type"]).toBeUndefined();
  });

  test("a 401 gets ONE retry, with a newer token from the source; with no newer token the 401 is the answer", async () => {
    tokenGeneration = 1;
    let asked = 0;
    const refreshing: KeyedTokenSource = {
      current: async () => ({ value: `token-${tokenGeneration}`, generation: tokenGeneration }),
      newer: async (after) => {
        asked += 1;
        tokenGeneration = after + 1;
        return { value: `token-${tokenGeneration}`, generation: tokenGeneration };
      },
    };
    const before = seen.length;
    const res = await createKeyedFetch({ hosts: hostsFor(), auth: { a: { source: refreshing } } })(`${base}/needs-new-token`, { method: "POST", body: "turn" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fresh");
    expect(asked).toBe(1);
    expect(seen.slice(before).map((s) => [s.headers["authorization"], s.body])).toEqual([["Bearer token-1", "turn"], ["Bearer token-2", "turn"]]);

    const stuck = seen.length;
    const never = await createKeyedFetch({ hosts: hostsFor(), auth: { a: fixed("old") } })(`${base}/always-401`);
    expect(never.status).toBe(401);
    expect(seen.length - stuck).toBe(1);

    let bumps = 0;
    const alwaysNewer: KeyedTokenSource = { current: async () => ({ value: "g1", generation: 1 }), newer: async (g) => ({ value: `g${g + 1 + bumps++}`, generation: g + 1 }) };
    const once = seen.length;
    const twice = await createKeyedFetch({ hosts: hostsFor(), auth: { a: { source: alwaysNewer } } })(`${base}/always-401`);
    expect(twice.status).toBe(401);
    expect(seen.length - once).toBe(2);
  });

  test("no time limit while data flows; silence past the idle limit ends the request typed", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor(), idleTimeoutMs: 250 });
    const res = await keyed(`${base}/slow-stream`);
    // 3 chunks over ~360 ms, against a 250 ms idle limit: never silent that long, so it completes.
    expect(await res.text()).toBe("abc");
    const stalled = await keyed(`${base}/stall`);
    const reader = stalled.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");
    const err = await reader.read().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(KeyedFetchError);
    expect((err as KeyedFetchError).code).toBe("idle_timeout");
  });

  test("a streamed upload is sent as it is read; the caller's abort ends the request typed", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor() });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("part-1,"));
        controller.enqueue(new TextEncoder().encode("part-2"));
        controller.close();
      },
    });
    await keyed(`${base}/ok`, { method: "POST", body });
    expect(seen.at(-1)?.body).toBe("part-1,part-2");
    const controller = new AbortController();
    const pending = keyed(`${base}/stall`, { signal: controller.signal });
    const res = await pending;
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    const err = await reader.read().then(() => undefined, (e: unknown) => e);
    expect((err as KeyedFetchError).code).toBe("aborted");
    controller.abort();
    await expect(keyed(`${base}/ok`, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  test("an error never carries the key", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor(), auth: { a: fixed("sk-SECRET-VALUE") } });
    for (const call of [() => keyed(`${other}/ok`), () => keyed(`${base}/redirect-away`), () => keyed(`${base}/ok`, { headers: { authorization: "x" } })]) {
      const err = await call().then(() => undefined, (e: unknown) => e);
      expect(String((err as Error).message)).not.toContain("sk-SECRET-VALUE");
    }
  });
});

describe("the keyed fetch: the key's placement is the entry's, and the key never comes back (review B1)", () => {
  test("an entry's placement is taken from the closed list only; anything else refuses the config", () => {
    for (const header of ["origin", "host", "x-request-id", "connection", "cookie", "x-forwarded-for"]) {
      expect(() => createKeyedFetch({ hosts: hostsFor(), auth: { a: { ...fixed("k"), placement: { header } as never } } })).toThrow(TypeError);
    }
    expect(() => createKeyedFetch({ hosts: hostsFor(), auth: { a: { ...fixed("k"), placement: { header: "x-api-key", scheme: "Bearer" } as never } } })).toThrow(TypeError);
    expect(() => createKeyedFetch({ hosts: hostsFor(), auth: { a: { ...fixed("k"), placement: { header: "authorization", scheme: "Bearer x" } } } })).toThrow(TypeError);
    for (const header of ["authorization", "x-api-key", "api-key", "x-goog-api-key"] as const) {
      expect(() => createKeyedFetch({ hosts: hostsFor(), auth: { a: { ...fixed("k"), placement: { header } as never } } })).not.toThrow();
    }
  });

  test("a request cannot choose a placement: an unknown option is ignored and the key goes where the entry says", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor(), auth: { a: fixed("sk-placed") } });
    await (await keyed(`${base}/ok`, {}, { placement: { header: "origin" } } as never)).text();
    expect(seen.at(-1)?.headers["authorization"]).toBe("Bearer sk-placed");
    expect(seen.at(-1)?.headers["origin"]).toBeUndefined();
  });

  test("every response header whose value carries the key is removed, as sent or %-encoded; the rest stay", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor(), auth: { a: fixed("sk-ECHOED/1+x") } });
    const res = await keyed(`${base}/echo-key`);
    await res.text();
    expect(res.headers.get("x-echo")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-request-uri")).toBeNull(); // the %-encoded form
    expect(res.headers.get("x-plain")).toBe("kept");
    expect([...res.headers.values()].join(" ")).not.toContain("sk-ECHOED");
  });

  test("the caller's abort reaches a token source that is still answering, and a newer() after a 401", async () => {
    const slow: KeyedTokenSource = { current: () => new Promise((resolve) => setTimeout(() => resolve({ value: "late", generation: 1 }), 2000)), newer: async () => null };
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    await expect(createKeyedFetch({ hosts: hostsFor(), auth: { a: { source: slow } } })(`${base}/ok`, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(Date.now() - started).toBeLessThan(1000);
    const slowNewer: KeyedTokenSource = { current: async () => ({ value: "old", generation: 1 }), newer: () => new Promise((resolve) => setTimeout(() => resolve({ value: "new", generation: 2 }), 2000)) };
    const second = new AbortController();
    const t0 = Date.now();
    setTimeout(() => second.abort(), 150);
    await expect(createKeyedFetch({ hosts: hostsFor(), auth: { a: { source: slowNewer } } })(`${base}/always-401`, { signal: second.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("a token source that throws, and malformed headers, fail with closed codes and say nothing of the cause", async () => {
    const broken: KeyedTokenSource = { current: async () => { throw new Error("keychain said sk-LEAK"); }, newer: async () => null };
    const err = await createKeyedFetch({ hosts: hostsFor(), auth: { a: { source: broken } } })(`${base}/ok`).then(() => undefined, (e: unknown) => e as KeyedFetchError);
    expect(err?.code).toBe("no_credential");
    expect(err?.message).not.toContain("sk-LEAK");
    await expect(createKeyedFetch({ hosts: hostsFor() })(`${base}/ok`, { headers: { "bad header": "x" } })).rejects.toMatchObject({ code: "refused" });
  });

  test("a streamed body is never replayed after a 401, and a cross-origin hop carries no key", async () => {
    let asked = 0;
    const source: KeyedTokenSource = { current: async () => ({ value: "s1", generation: 1 }), newer: async () => { asked += 1; return { value: "s2", generation: 2 }; } };
    const before = seen.length;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("once")); c.close(); } });
    const res = await createKeyedFetch({ hosts: hostsFor(), auth: { a: { source } } })(`${base}/always-401`, { method: "POST", body });
    expect(res.status).toBe(401);
    expect(seen.length - before).toBe(1);
    expect(asked).toBe(0);
  });

  test("a request's own idle limit applies to that request", async () => {
    const keyed = createKeyedFetch({ hosts: hostsFor() });
    // 120 ms between chunks: fine under the default, cut short by a 50 ms request limit.
    const err = await keyed(`${base}/slow-stream`, {}, { idleTimeoutMs: 50 }).then((r) => r.text()).then(() => undefined, (e: unknown) => e as KeyedFetchError);
    expect(err?.code).toBe("idle_timeout");
    expect(await (await keyed(`${base}/slow-stream`)).text()).toBe("abc");
  });
});

describe("tokenSourceFromCredentialStore", () => {
  test("each new value is a new generation; `newer` asks a brokered store to renew and otherwise re-reads", async () => {
    const ref = { kind: "keychain", account: "p:default" } as const;
    const store = createMemoryCredentialStore([[ref, { kind: "api-key", key: "one" }]]);
    const source = tokenSourceFromCredentialStore(store, ref);
    expect(await source.current()).toEqual({ value: "one", generation: 1 });
    expect(await source.newer(1)).toBeNull();
    await store.set(ref, { kind: "api-key", key: "two" });
    expect(await source.newer(1)).toEqual({ value: "two", generation: 2 });

    let renewals = 0;
    const brokered: CredentialStore = {
      get: async () => ({ kind: "oauth", accessToken: "at-1" }),
      set: async () => {},
      delete: async () => {},
      refresh: async (): Promise<CredentialMaterial> => ({ kind: "oauth", accessToken: `at-${++renewals + 1}` }),
    };
    const renewing = tokenSourceFromCredentialStore(brokered, ref);
    expect(await renewing.current()).toEqual({ value: "at-1", generation: 1 });
    expect(await renewing.newer(1)).toEqual({ value: "at-2", generation: 2 });
    expect(renewals).toBe(1);
  });

  test("signing material is refused: it belongs to a process of the adapter's own", async () => {
    const ref = { kind: "keychain", account: "aws" } as const;
    const store = createMemoryCredentialStore([[ref, { kind: "aws", accessKeyId: "AKIA", secretAccessKey: "s" }]]);
    await expect(tokenSourceFromCredentialStore(store, ref).current()).rejects.toMatchObject({ code: "no_credential" });
  });
});
