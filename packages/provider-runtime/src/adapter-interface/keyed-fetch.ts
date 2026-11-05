// THE REFERENCE KEYED FETCH: spec §5.4's `net.fetch`, as one function over a plugin's declared hosts and
// its `auth` entries. The daemon's plugin API implements the same door (lane B's `net.fetch`); the
// conformance kit's keyed-fetch cases (`runKeyedFetchConformance`) hold both to the same behaviour:
//
//   1. ONLY DECLARED HOSTS. The request URL's host and port must be one of the plugin's `network:`
//      hosts (`network-hosts.ts`), checked before anything is sent. `https:` only, except plain `http:`
//      to this computer's loopback (a model served locally, a test's fake). No user info in a URL.
//   2. THE KEY IS ADDED HERE, WHERE ITS ENTRY SAYS. Each `auth` entry carries its placement, declared
//      once (the plugin's manifest, held by the core) and taken from a closed list: `authorization`
//      with a scheme (default `Bearer`), `x-api-key`, `api-key` or `x-goog-api-key`. A request names
//      only WHICH entry; it never chooses where the key goes, so it can never steer the key into a
//      header a server reflects (`origin`, `x-request-id`) or one that changes the request (`host`). A
//      request that sets its entry's header itself is refused (`credential_header`).
//   3. THE KEY NEVER COMES BACK. Every response header whose value contains a key or token sent in
//      this exchange is removed before the caller sees the response.
//   4. REDIRECTS ARE FOLLOWED BY HAND. Each hop's target is held to rule 1, so a redirect elsewhere is
//      refused (`redirect_refused`); a hop to another origin drops the key (the token was minted for
//      the first); 303 (and 301/302 of a POST) turns into a GET with no body; a streamed body cannot be
//      sent twice, so a hop that would replay one is refused.
//   5. NO TIME LIMIT WHILE DATA FLOWS. One idle watchdog, re-armed by every chunk sent, received or
//      read: a generation may stream for an hour, and only silence (five minutes by default, or the
//      request's own `idleTimeoutMs`) ends it, as `idle_timeout`. Cancelling the body releases the
//      socket at once. (Bun drains a Response's body as it arrives whether or not the caller reads, so
//      an abandoned body runs until the server ends or goes silent.)
//   6. A 401 GETS ONE RETRY. The entry's token source is asked for a token newer than the one sent (the
//      core's refresher, §8.5); when there is one and the body can be sent again, the request is
//      retried once with it. Otherwise the 401 is the answer.
//
// The caller's abort reaches every wait, the token source's included. Every failure is a
// `KeyedFetchError` with a closed `code`, and none carries a key, a token or a response body. Nothing
// here logs.
import type { KeyedFetch, KeyedFetchInit, KeyedFetchOptions } from "./types.ts";
import { hostAllowed, isLoopbackHost, parseNetworkHosts } from "./network-hosts.ts";

/** One key or token, with the generation the source gave it (a newer token has a higher one). */
export interface KeyedToken {
  value: string;
  generation: number;
}

/** Where one `auth` entry's key or token comes from: the core's secret store and refresher. */
export interface KeyedTokenSource {
  /** The current key or token, or `null` when nothing is stored. */
  current(): Promise<KeyedToken | null>;
  /** A token NEWER than `generation` (after a 401), or `null` when there is none. */
  newer(generation: number): Promise<KeyedToken | null>;
}

/** The only headers a key may go in (rule 2). */
export const KEY_HEADERS = ["authorization", "x-api-key", "api-key", "x-goog-api-key"] as const;
export type KeyHeader = (typeof KEY_HEADERS)[number];

/** Where an `auth` entry's key goes: declared once per entry, never per request. */
export type KeyPlacement = { header: "authorization"; scheme?: string } | { header: Exclude<KeyHeader, "authorization"> };

/** `Authorization: Bearer <key>`: the placement of an entry that declares none. */
export const DEFAULT_KEY_PLACEMENT: KeyPlacement = { header: "authorization", scheme: "Bearer" };

/** One `auth` entry as the core holds it: its token source and its declared placement. */
export interface KeyedAuthEntry {
  source: KeyedTokenSource;
  placement?: KeyPlacement;
}

export type KeyedFetchErrorCode =
  | "host_not_declared"
  | "insecure_url"
  | "redirect_refused"
  | "unknown_auth"
  | "ambiguous_auth"
  | "no_credential"
  | "credential_header"
  | "idle_timeout"
  | "aborted"
  | "network"
  | "refused";

export class KeyedFetchError extends Error {
  readonly code: KeyedFetchErrorCode;
  constructor(code: KeyedFetchErrorCode, message: string) {
    super(message);
    this.name = "KeyedFetchError";
    this.code = code;
  }
}

export interface KeyedFetchConfig {
  /** The plugin's `network:` hosts. An entry that is not a host refuses the whole config (TypeError). */
  hosts: readonly string[];
  /** The plugin's `auth` entries, by `secret` name. A placement off the closed list refuses the config (TypeError). */
  auth?: Readonly<Record<string, KeyedAuthEntry>>;
  /** No data either way for this long ends a request, unless the request names its own. Default `DEFAULT_KEYED_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  /** Hops followed before refusing. Default 5. */
  maxRedirects?: number;
  /**
   * False: a 3xx is returned as it came, for a caller that follows redirects by hand and checks each
   * hop itself (each hop then comes back through this fetch and its host check). Default true.
   */
  followRedirects?: boolean;
  /** The platform fetch (a test seam). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export const DEFAULT_KEYED_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_REDIRECTS = 5;
/** An HTTP auth scheme: an RFC 9110 token (the same rule as the core's `net.fetch`, lane B's plugin SDK). */
export const AUTH_SCHEME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,32}$/;

/** The entry's placement, checked against the closed list; `null` describes why it is refused. */
function checkedPlacement(name: string, placement: KeyPlacement | undefined): { header: KeyHeader; scheme: string | undefined } {
  const p = placement ?? DEFAULT_KEY_PLACEMENT;
  const header = String(p.header).toLowerCase();
  if (!(KEY_HEADERS as readonly string[]).includes(header)) {
    throw new TypeError(`auth entry ${JSON.stringify(name)}: a key goes only in ${KEY_HEADERS.join(", ")}, not ${JSON.stringify(p.header)}`);
  }
  if (header !== "authorization") {
    if ("scheme" in p && (p as { scheme?: unknown }).scheme !== undefined) throw new TypeError(`auth entry ${JSON.stringify(name)}: only authorization takes a scheme`);
    return { header: header as KeyHeader, scheme: undefined };
  }
  const scheme = (p as { scheme?: string }).scheme ?? "Bearer";
  if (!AUTH_SCHEME_RE.test(scheme)) throw new TypeError(`auth entry ${JSON.stringify(name)}: ${JSON.stringify(scheme)} is not an auth scheme`);
  return { header: "authorization", scheme };
}

/** Rejects with `aborted` when `signal` fires first; never leaves a listener behind. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new KeyedFetchError("aborted", "the request was aborted by the caller"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new KeyedFetchError("aborted", "the request was aborted by the caller"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Re-arms the watchdog on every chunk read from `source` (the upload side). */
function tapUpload(source: ReadableStream<Uint8Array>, onChunk: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      onChunk();
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * A copy of `headers` without any whose value contains one of `secrets`, as sent or %-encoded (rule 3; the same
 * rule as the core's `net.fetch`, lane B's `stripEchoedKey`). Each `set-cookie` line is judged on its own.
 */
function withoutEchoes(headers: Headers, secrets: ReadonlySet<string>): Headers {
  const forms = new Set<string>();
  for (const secret of secrets) if (secret.length > 0) { forms.add(secret); forms.add(encodeURIComponent(secret)); }
  const out = new Headers();
  headers.forEach((value, name) => {
    for (const form of forms) if (value.includes(form)) return;
    out.append(name, value);
  });
  return out;
}

export function createKeyedFetch(config: KeyedFetchConfig): KeyedFetch {
  const hosts = parseNetworkHosts(config.hosts);
  const entries = new Map<string, { source: KeyedTokenSource; header: KeyHeader; scheme: string | undefined }>();
  for (const [name, entry] of Object.entries(config.auth ?? {})) {
    entries.set(name, { source: entry.source, ...checkedPlacement(name, entry.placement) });
  }
  const defaultIdleMs = config.idleTimeoutMs ?? DEFAULT_KEYED_IDLE_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const followRedirects = config.followRedirects !== false;
  const platformFetch = config.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  const checkUrl = (raw: string, hop: "request" | "redirect"): URL => {
    const what = hop === "request" ? "the request URL" : "the redirect target";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new KeyedFetchError(hop === "request" ? "insecure_url" : "redirect_refused", `${what} is not an absolute URL`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new KeyedFetchError(hop === "request" ? "insecure_url" : "redirect_refused", `${what} carries user info`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url))) {
      throw new KeyedFetchError(hop === "request" ? "insecure_url" : "redirect_refused", `${url.protocol}//${url.host} is not https (plain http reaches only this computer's loopback)`);
    }
    if (!hostAllowed(url, hosts)) {
      throw new KeyedFetchError(hop === "request" ? "host_not_declared" : "redirect_refused", `${url.host} is not one of this plugin's network hosts`);
    }
    return url;
  };

  return async (rawUrl: string, init: KeyedFetchInit = {}, options: KeyedFetchOptions = {}): Promise<Response> => {
    const signal = init.signal;
    if (signal?.aborted === true) throw new KeyedFetchError("aborted", "the request was aborted before it was sent");
    const idleMs = options.idleTimeoutMs ?? defaultIdleMs;

    // ONE controller for the whole exchange, every hop and the body: the watchdog and the caller abort it.
    const controller = new AbortController();
    let idleFired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        idleFired = true;
        controller.abort();
        signal?.removeEventListener("abort", onCallerAbort);
      }, idleMs);
      // The watchdog never holds a process open by itself: a response its caller abandoned (body never read)
      // must not keep a one-shot host alive for the whole idle limit. A live exchange keeps its own handles.
      (timer as { unref?: () => void }).unref?.();
    };
    const pause = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const finish = (): void => {
      pause();
      signal?.removeEventListener("abort", onCallerAbort);
    };
    const failure = (err: unknown): KeyedFetchError => {
      if (idleFired) return new KeyedFetchError("idle_timeout", `no data moved for ${idleMs} ms`);
      if (signal?.aborted === true) return new KeyedFetchError("aborted", "the request was aborted by the caller");
      if (err instanceof KeyedFetchError) return err;
      return new KeyedFetchError("network", err instanceof Error ? `${err.name}: the request failed in transport` : "the request failed in transport");
    };

    try {
      let url = checkUrl(rawUrl, "request");

      let entry: { source: KeyedTokenSource; header: KeyHeader; scheme: string | undefined } | undefined;
      if (options.auth === false) entry = undefined;
      else if (typeof options.auth === "string") {
        entry = entries.get(options.auth);
        if (entry === undefined) throw new KeyedFetchError("unknown_auth", `this plugin has no auth entry named ${JSON.stringify(options.auth)}`);
      } else if (entries.size === 1) entry = [...entries.values()][0];
      else if (entries.size > 1) throw new KeyedFetchError("ambiguous_auth", `this plugin has ${entries.size} auth entries; name the one to add`);

      let headers: Headers;
      try {
        headers = new Headers(init.headers ?? {});
      } catch {
        throw new KeyedFetchError("refused", "the request's headers are not valid HTTP headers");
      }
      if (entry !== undefined && headers.has(entry.header)) {
        throw new KeyedFetchError("credential_header", `the request sets ${entry.header} itself; the keyed fetch adds the key there`);
      }
      let token: KeyedToken | null = null;
      if (entry !== undefined) {
        try {
          token = await raceAbort(entry.source.current(), signal);
        } catch (err) {
          if (err instanceof KeyedFetchError) throw err;
          throw new KeyedFetchError("no_credential", "the key or token for this plugin's auth entry could not be read");
        }
        if (token === null) throw new KeyedFetchError("no_credential", "no key or token is stored for this plugin's auth entry; sign in first");
      }
      const sentSecrets = new Set<string>();

      let method = (init.method ?? "GET").toUpperCase();
      let body: KeyedFetchInit["body"] = init.body ?? undefined;
      const streamedBody = body instanceof ReadableStream;
      if (streamedBody) body = tapUpload(body as ReadableStream<Uint8Array>, arm);
      let keyOn = entry !== undefined;
      let retried = false;
      let hops = 0;

      for (;;) {
        const sent = new Headers(headers);
        if (keyOn && token !== null && entry !== undefined) {
          sent.set(entry.header, entry.scheme === undefined ? token.value : `${entry.scheme} ${token.value}`);
          sentSecrets.add(token.value);
        }
        arm();
        let response: Response;
        try {
          const requestInit: RequestInit & { duplex?: "half" } = { method, headers: sent, redirect: "manual", signal: controller.signal };
          if (body !== undefined && body !== null) {
            requestInit.body = body as BodyInit;
            if (streamedBody) requestInit.duplex = "half";
          }
          response = await platformFetch(url.toString(), requestInit);
        } catch (err) {
          throw failure(err);
        }

        const location = followRedirects && response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (location !== null) {
          void response.body?.cancel().catch(() => {});
          hops += 1;
          if (hops > maxRedirects) throw new KeyedFetchError("redirect_refused", `more than ${maxRedirects} redirects`);
          let target: URL;
          try {
            target = checkUrl(new URL(location, url).toString(), "redirect");
          } catch (err) {
            throw err instanceof KeyedFetchError ? err : new KeyedFetchError("redirect_refused", "the redirect target is not a URL");
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = method === "HEAD" ? "HEAD" : "GET";
            body = undefined;
            headers = new Headers(headers);
            headers.delete("content-type");
            headers.delete("content-length");
          } else if (streamedBody && body !== undefined) {
            throw new KeyedFetchError("redirect_refused", "the redirect would send a streamed body a second time");
          }
          if (target.origin !== url.origin) keyOn = false;
          url = target;
          continue;
        }

        if (response.status === 401 && keyOn && token !== null && entry !== undefined && !retried && !streamedBody) {
          retried = true;
          let next: KeyedToken | null;
          try {
            next = await raceAbort(entry.source.newer(token.generation), signal);
          } catch (err) {
            void response.body?.cancel().catch(() => {});
            if (err instanceof KeyedFetchError) throw err;
            throw new KeyedFetchError("no_credential", "a newer key or token for this plugin's auth entry could not be read");
          }
          if (next !== null && next.generation > token.generation) {
            void response.body?.cancel().catch(() => {});
            token = next;
            continue;
          }
        }

        const safeHeaders = withoutEchoes(response.headers, sentSecrets);
        if (response.body === null) {
          finish();
          return new Response(null, { status: response.status, statusText: response.statusText, headers: safeHeaders });
        }
        // The body: the watchdog runs from the headers on and is re-armed by every chunk read, so a
        // silent server and a caller that stopped reading both end as `idle_timeout`, socket released.
        const reader = response.body.getReader();
        arm();
        const tapped = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
              chunk = await reader.read();
            } catch (err) {
              finish();
              streamController.error(failure(err));
              return;
            }
            if (chunk.done) {
              finish();
              streamController.close();
              return;
            }
            arm();
            streamController.enqueue(chunk.value);
          },
          cancel(reason) {
            finish();
            void reader.cancel(reason).catch(() => {});
          },
        }, { highWaterMark: 0 });
        return new Response(tapped, { status: response.status, statusText: response.statusText, headers: safeHeaders });
      }
    } catch (err) {
      finish();
      controller.abort();
      throw failure(err);
    }
  };
}
