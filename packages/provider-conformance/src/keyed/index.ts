// THE CONFORMANCE KIT ON THE MODEL ADAPTER INTERFACE (Clover A-M1): the questions every keyed fetch and
// every model adapter is asked, as DATA plus a runner, like the corpus (`corpus/runner.ts`).
//
//   runKeyedFetchConformance(make): any implementation of spec §5.4's `net.fetch` -- the SDK's reference
//     `createKeyedFetch`, and the daemon's plugin API -- against a loopback fake: declared hosts only,
//     the key added where the adapter says and nowhere else, redirects, the 401 retry, streaming with no
//     time limit while data flows. Two implementations that pass are interchangeable to an adapter.
//
//   runModelAdapterConformance(opts): a model adapter against its family's fake: it speaks the
//     interface version, reads nothing but the context the interface hands it (no credential store, no
//     reference), sends every request through `ctx.fetch` (a direct `fetch` is a failure), never sets
//     a credential header itself, and stops when its turn is aborted.
//
// The per-family corpora (`corpus/<family>.ts`) still ask their questions of `ProviderAdapter`s; each
// family moves onto this interface when its adapter moves into its model plugin (A-M2).
import { KeyedFetchError, MODEL_ADAPTER_INTERFACE_VERSION, type AdapterContext, type KeyedFetch, type KeyedFetchConfig, type KeyedTokenSource, type ModelAdapter } from "@waifucave/clover-provider-runtime";
import type { TurnRequest } from "@waifucave/clover-provider-runtime";
import { startFake } from "../fakes/server.ts";
import { describeCaseFailure } from "../corpus/classifier-safety.ts";

export interface ConformanceCaseSpec<Id extends string> {
  id: Id;
  question: string;
}

export interface ConformanceOutcome<Id extends string> {
  id: Id;
  status: "passed" | "failed" | "skipped";
  detail?: string;
}

export interface ConformanceReport<Id extends string> {
  subject: string;
  outcomes: Array<ConformanceOutcome<Id>>;
  ok: boolean;
}

export function formatConformanceReport<Id extends string>(report: ConformanceReport<Id>, cases: ReadonlyArray<ConformanceCaseSpec<Id>>): string {
  const byId = new Map(cases.map((c) => [c.id, c.question]));
  return [`conformance: ${report.subject} -- ${report.ok ? "OK" : "FAILED"}`, ...report.outcomes.map((o) => `  ${o.status.padEnd(7)} ${o.id}${o.detail === undefined ? "" : ` -- ${o.detail}`}  (${byId.get(o.id) ?? ""})`)].join("\n");
}

/** A case that does not finish in this long is a failure, never a hung run. */
export const CONFORMANCE_CASE_TIMEOUT_MS = 5000;

async function bounded<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the case did not finish in ${CONFORMANCE_CASE_TIMEOUT_MS} ms`)), CONFORMANCE_CASE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    const res = await promise;
    if (res instanceof Response) await res.body?.cancel().catch(() => {});
    return undefined;
  } catch (err) {
    return err instanceof KeyedFetchError || (err !== null && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") ? String((err as { code: string }).code) : "untyped";
  }
}

// --- the keyed fetch ---------------------------------------------------------------------------------

export type KeyedFetchCaseId =
  | "declared-hosts-only"
  | "https-or-loopback"
  | "key-in-placement"
  | "caller-cannot-set-the-key"
  | "auth-entry-choice"
  | "redirect-same-origin-keeps-key"
  | "redirect-cross-origin-drops-key"
  | "redirect-elsewhere-refused"
  | "retry-401-once-with-newer-token"
  | "stream-without-time-limit"
  | "idle-ends-typed";

export const KEYED_FETCH_CASES: ReadonlyArray<ConformanceCaseSpec<KeyedFetchCaseId>> = [
  { id: "declared-hosts-only", question: "is a request to a host the plugin did not declare refused before anything is sent?" },
  { id: "https-or-loopback", question: "is plain http refused except to this computer's loopback?" },
  { id: "key-in-placement", question: "does the key go in the header the adapter names (default `Authorization: Bearer`), and only there?" },
  { id: "caller-cannot-set-the-key", question: "is a request that sets the key's header itself refused?" },
  { id: "auth-entry-choice", question: "is the only auth entry used by default, a named one on request, none with `auth: false`, and several without a name refused?" },
  { id: "redirect-same-origin-keeps-key", question: "does a same-origin redirect keep the key?" },
  { id: "redirect-cross-origin-drops-key", question: "does a redirect to another declared origin drop the key?" },
  { id: "redirect-elsewhere-refused", question: "is a redirect to an undeclared host refused?" },
  { id: "retry-401-once-with-newer-token", question: "after a 401, is the request retried exactly once, with a newer token from the source?" },
  { id: "stream-without-time-limit", question: "does a response that keeps sending outlive the idle limit?" },
  { id: "idle-ends-typed", question: "does silence past the idle limit end the request as `idle_timeout`?" },
];

/** What the kit asks an implementation to build: the reference's own config shape. */
export type KeyedFetchFactory = (config: Pick<KeyedFetchConfig, "hosts" | "auth" | "idleTimeoutMs">) => KeyedFetch;

export async function runKeyedFetchConformance(subject: string, make: KeyedFetchFactory): Promise<ConformanceReport<KeyedFetchCaseId>> {
  let otherUrl = "";
  let generation = 1;
  const fake = await startFake({
    routes: [
      { path: "/ok", handler: () => new Response("ok") },
      { path: "/same", handler: () => new Response(null, { status: 302, headers: { location: "/ok" } }) },
      { path: "/cross", handler: () => new Response(null, { status: 307, headers: { location: `${otherUrl}/ok` } }) },
      { path: "/away", handler: () => new Response(null, { status: 302, headers: { location: "https://undeclared.example/ok" } }) },
      { path: "/fresh-only", handler: (req) => (req.headers.get("authorization") === `Bearer t${generation}` && generation > 1 ? new Response("fresh") : new Response("no", { status: 401 })) },
      {
        path: "/drip",
        handler: () =>
          new Response(new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const part of ["1", "2", "3", "4"]) {
                controller.enqueue(new TextEncoder().encode(part));
                await Bun.sleep(80);
              }
              controller.close();
            },
          })),
      },
      { path: "/silent", handler: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("x")); } })) },
    ],
  });
  const port = new URL(fake.url).port;
  otherUrl = `http://localhost:${port}`;
  const fixed = (value: string): KeyedTokenSource => ({ current: async () => ({ value, generation: 1 }), newer: async () => null });
  const declared = [`127.0.0.1:${port}`];
  // The fake records every request with its credential headers redacted to their scheme (`Bearer ***`),
  // which is exactly what these cases ask about: whether a key was there, and where.
  const probe = async (keyed: KeyedFetch, path: string, init?: Parameters<KeyedFetch>[1], options?: Parameters<KeyedFetch>[2]): Promise<Response> => keyed(`${fake.url}${path}`, init, options);

  const cases: Record<KeyedFetchCaseId, () => Promise<void>> = {
    "declared-hosts-only": async () => {
      const before = fake.requests.length;
      check((await refusal(make({ hosts: ["api.example.com"] })(`${fake.url}/ok`))) === "host_not_declared", "an undeclared host was not refused as host_not_declared");
      check(fake.requests.length === before, "a request reached the fake for an undeclared host");
    },
    "https-or-loopback": async () => {
      check((await refusal(make({ hosts: ["api.example.com"] })("http://api.example.com/v1"))) === "insecure_url", "plain http to a non-loopback host was not refused as insecure_url");
      const res = await make({ hosts: declared })(`${fake.url}/ok`);
      check(res.status === 200, "plain http to loopback was refused");
      await res.text();
    },
    "key-in-placement": async () => {
      const keyed = make({ hosts: declared, auth: { a: fixed("conformance-key") } });
      await (await probe(keyed, "/ok")).text();
      const bearer = fake.requests.at(-1)!;
      check(bearer.headers["authorization"] === "Bearer ***", "the default placement is not `Authorization: Bearer`");
      await (await probe(keyed, "/ok", {}, { placement: { header: "x-api-key" } })).text();
      const custom = fake.requests.at(-1)!;
      check(custom.headers["x-api-key"] === "***" && custom.headers["authorization"] === undefined, "a named placement did not carry the key alone");
    },
    "caller-cannot-set-the-key": async () => {
      check((await refusal(make({ hosts: declared, auth: { a: fixed("k") } })(`${fake.url}/ok`, { headers: { authorization: "Bearer guess" } }))) === "credential_header", "a caller-set key header was not refused");
    },
    "auth-entry-choice": async () => {
      const one = make({ hosts: declared, auth: { only: fixed("k1") } });
      await (await probe(one, "/ok")).text();
      check(fake.requests.at(-1)!.headers["authorization"] === "Bearer ***", "the only entry was not used by default");
      await (await probe(one, "/ok", {}, { auth: false })).text();
      check(fake.requests.at(-1)!.headers["authorization"] === undefined, "`auth: false` still sent a key");
      check((await refusal(make({ hosts: declared, auth: { a: fixed("x"), b: fixed("y") } })(`${fake.url}/ok`))) === "ambiguous_auth", "several entries without a name were not refused");
      check((await refusal(make({ hosts: declared, auth: { a: fixed("x") } })(`${fake.url}/ok`, {}, { auth: "zz" }))) === "unknown_auth", "an unknown entry name was not refused");
    },
    "redirect-same-origin-keeps-key": async () => {
      await (await probe(make({ hosts: declared, auth: { a: fixed("k") } }), "/same")).text();
      const hop = fake.requests.at(-1)!;
      check(hop.path === "/ok" && hop.headers["authorization"] === "Bearer ***", "the same-origin hop lost the key");
    },
    "redirect-cross-origin-drops-key": async () => {
      await (await probe(make({ hosts: [...declared, `localhost:${port}`], auth: { a: fixed("k") } }), "/cross", { method: "POST", body: "b" })).text();
      const hop = fake.requests.at(-1)!;
      check(hop.path === "/ok" && hop.headers["authorization"] === undefined, "the cross-origin hop kept the key");
    },
    "redirect-elsewhere-refused": async () => {
      check((await refusal(make({ hosts: declared, auth: { a: fixed("k") } })(`${fake.url}/away`))) === "redirect_refused", "a redirect to an undeclared host was not refused");
    },
    "retry-401-once-with-newer-token": async () => {
      generation = 1;
      let asked = 0;
      const source: KeyedTokenSource = {
        current: async () => ({ value: `t${generation}`, generation }),
        newer: async (after) => {
          asked += 1;
          generation = after + 1;
          return { value: `t${generation}`, generation };
        },
      };
      const before = fake.requests.length;
      const res = await probe(make({ hosts: declared, auth: { a: source } }), "/fresh-only", { method: "POST", body: "turn" });
      check(res.status === 200 && (await res.text()) === "fresh", "the retry with the newer token did not succeed");
      check(asked === 1 && fake.requests.length - before === 2, `expected one retry, saw ${fake.requests.length - before} requests and ${asked} token asks`);
      const stuck = fake.requests.length;
      const again = await probe(make({ hosts: declared, auth: { a: fixed("old") } }), "/fresh-only");
      await again.text();
      check(again.status === 401 && fake.requests.length - stuck === 1, "with no newer token the 401 was not the answer");
    },
    "stream-without-time-limit": async () => {
      const res = await probe(make({ hosts: declared, idleTimeoutMs: 200 }), "/drip");
      check((await res.text()) === "1234", "a response that kept sending was cut off");
    },
    "idle-ends-typed": async () => {
      const res = await probe(make({ hosts: declared, idleTimeoutMs: 150 }), "/silent");
      const reader = res.body!.getReader();
      await reader.read();
      const code = await reader.read().then(() => "no error", (e: unknown) => String((e as { code?: string }).code ?? "untyped"));
      check(code === "idle_timeout", `silence ended as ${code}, not idle_timeout`);
    },
  };

  const outcomes: Array<ConformanceOutcome<KeyedFetchCaseId>> = [];
  try {
    for (const spec of KEYED_FETCH_CASES) {
      try {
        await bounded(cases[spec.id]);
        outcomes.push({ id: spec.id, status: "passed" });
      } catch (err) {
        outcomes.push({ id: spec.id, status: "failed", detail: describeCaseFailure(err) });
      }
    }
  } finally {
    await fake.close();
  }
  return { subject, outcomes, ok: outcomes.every((o) => o.status === "passed") };
}

// --- model adapters ----------------------------------------------------------------------------------

export type ModelAdapterCaseId = "interface-version" | "context-only" | "fetch-only" | "no-credential-header" | "abort-stops-turn";

export const MODEL_ADAPTER_CASES: ReadonlyArray<ConformanceCaseSpec<ModelAdapterCaseId>> = [
  { id: "interface-version", question: "does the adapter speak this interface version?" },
  { id: "context-only", question: "does a turn read only the members the interface hands it (no credential store, no reference)?" },
  { id: "fetch-only", question: "does every request go through `ctx.fetch`, never `fetch` itself?" },
  { id: "no-credential-header", question: "does the adapter leave the credential headers to the keyed fetch?" },
  { id: "abort-stops-turn", question: "does aborting a turn's signal end it promptly?" },
];

const CONTEXT_MEMBERS: ReadonlySet<string> = new Set(["connection", "fetch", "secrets", "stallTimeoutMs", "log", "signal", "limits"]);
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key"];

export interface RunModelAdapterConformanceOptions {
  subject: string;
  adapter: ModelAdapter;
  /** The context a turn runs with: its connection points at the family's fake, its fetch is a keyed fetch over it. */
  context(): AdapterContext;
  /** A turn the fake answers. */
  turn: TurnRequest;
  /** A turn the fake holds open (headers sent, no end), for the abort case; absent, the case is skipped. */
  holdingTurn?: TurnRequest;
  /**
   * True for an adapter in a process of its own, whose requests leave from that process (it signs
   * them): the host-side `fetch-only`/`no-credential-header` checks then see nothing, and the case
   * asserts the fake was reached anyway.
   */
  ownProcess?: boolean;
  /** For `ownProcess`: how many requests the fake has received (to see the turn reached it). */
  fakeRequests?: () => number;
}

export async function runModelAdapterConformance(opts: RunModelAdapterConformanceOptions): Promise<ConformanceReport<ModelAdapterCaseId>> {
  const drain = async (ctx: AdapterContext, req: TurnRequest): Promise<void> => {
    for await (const event of opts.adapter.streamTurn(req, ctx)) {
      if (event.type === "error") throw Object.assign(new Error(event.error.message), { code: event.error.code });
    }
  };
  const cases: Record<ModelAdapterCaseId, () => Promise<void | { skipped: string }>> = {
    "interface-version": async () => {
      check(opts.adapter.interfaceVersion === MODEL_ADAPTER_INTERFACE_VERSION, `the adapter speaks interface ${String(opts.adapter.interfaceVersion)}, not ${MODEL_ADAPTER_INTERFACE_VERSION}`);
    },
    "context-only": async () => {
      const read = new Set<string>();
      const base = opts.context();
      const watched = new Proxy(base, {
        get(target, key, receiver) {
          if (typeof key === "string") read.add(key);
          return Reflect.get(target, key, receiver);
        },
      });
      await drain(watched, opts.turn);
      const foreign = [...read].filter((key) => !CONTEXT_MEMBERS.has(key) && key !== "then");
      check(foreign.length === 0, `the turn read context members the interface does not hand it: ${foreign.join(", ")}`);
    },
    "fetch-only": async () => {
      const platform = globalThis.fetch;
      let direct = 0;
      let keyed = 0;
      const base = opts.context();
      globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
        direct += 1;
        return platform(...args);
      }, { preconnect: platform.preconnect }) as typeof fetch;
      try {
        const before = opts.fakeRequests?.() ?? 0;
        await drain({ ...base, fetch: (url, init, options) => { keyed += 1; return base.fetch(url, init, options); } }, opts.turn);
        if (opts.ownProcess === true) {
          check((opts.fakeRequests?.() ?? 0) > before, "the own-process turn never reached its fake");
          check(direct === 0 && keyed === 0, "an own-process adapter's host side made a request itself");
          return;
        }
        check(keyed > 0, "the turn made no request through ctx.fetch");
      } finally {
        globalThis.fetch = platform;
      }
      // The reference keyed fetch itself calls the platform fetch once per request; more is a direct call.
      check(direct <= keyed + 2, `the adapter called fetch directly (${direct} platform calls for ${keyed} keyed ones)`);
    },
    "no-credential-header": async () => {
      if (opts.ownProcess === true) return { skipped: "an adapter in a process of its own signs its requests itself" };
      const base = opts.context();
      const set: string[] = [];
      await drain({
        ...base,
        fetch: (url, init, options) => {
          for (const name of Object.keys(init?.headers ?? {})) if (CREDENTIAL_HEADERS.includes(name.toLowerCase())) set.push(name);
          return base.fetch(url, init, options);
        },
      }, opts.turn);
      check(set.length === 0, `the adapter set credential headers itself: ${set.join(", ")}`);
    },
    "abort-stops-turn": async () => {
      if (opts.holdingTurn === undefined) return { skipped: "no holding turn supplied" };
      const controller = new AbortController();
      const started = Date.now();
      const done = drain(opts.context(), { ...opts.holdingTurn, signal: controller.signal }).catch(() => {});
      await Bun.sleep(100);
      controller.abort();
      await done;
      check(Date.now() - started < 5000, "the turn did not end promptly after its abort");
    },
  };
  const outcomes: Array<ConformanceOutcome<ModelAdapterCaseId>> = [];
  for (const spec of MODEL_ADAPTER_CASES) {
    try {
      const result = await bounded(cases[spec.id]);
      outcomes.push(result !== undefined && "skipped" in result ? { id: spec.id, status: "skipped", detail: result.skipped } : { id: spec.id, status: "passed" });
    } catch (err) {
      outcomes.push({ id: spec.id, status: "failed", detail: describeCaseFailure(err) });
    }
  }
  return { subject: opts.subject, outcomes, ok: outcomes.every((o) => o.status !== "failed") };
}
