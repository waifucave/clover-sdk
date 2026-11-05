// THE REFERENCE KEYED FETCH: spec §5.4's `net.fetch`, as one function over a plugin's declared hosts and
// its `auth` entries' token sources. The daemon's plugin API implements the same door (lane B's
// `net.fetch`); the conformance kit's keyed-fetch cases (`runKeyedFetchConformance`) hold both to the
// same behaviour, which is:
//
//   1. ONLY DECLARED HOSTS. The request URL's host and port must be one of the plugin's `network:`
//      hosts (`network-hosts.ts`), checked before anything is sent. `https:` only, except plain `http:`
//      to this computer's loopback (a model served locally, a test's fake). No user info in a URL.
//   2. THE KEY IS ADDED HERE. The named `auth` entry's current key or token goes in the placement the
//      adapter names (default `Authorization: Bearer …`). A caller that sets that header itself is
//      refused (`credential_header`): it holds no key, so whatever it wrote is a bug to make loud.
//   3. REDIRECTS ARE FOLLOWED BY HAND. Each hop's target is held to rule 1, so a redirect elsewhere is
//      refused (`redirect_refused`); a hop to another origin drops the key (the token was minted for
//      the first); 303 (and 301/302 of a POST) turns into a GET with no body; a streamed body cannot be
//      sent twice, so a hop that would replay one is refused.
//   4. NO TIME LIMIT WHILE DATA FLOWS. One idle watchdog, re-armed by every chunk sent and every chunk
//      received, and paused while the caller is not reading: a generation may stream for an hour, and
//      only silence (five minutes by default) ends it, as `idle_timeout`.
//   5. A 401 GETS ONE RETRY. The token source is asked for a token newer than the one sent (the core's
//      refresher, §8.5); when there is one and the body can be sent again, the request is retried once
//      with it. Otherwise the 401 is the answer.
//
// Errors are `KeyedFetchError`s with a closed `code`, and never carry a key, a token or a response
// body. Nothing here logs.
import type { AuthPlacement, KeyedFetch, KeyedFetchInit, KeyedFetchOptions } from "./types.ts";
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
  | "network";

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
  /** The plugin's `auth` entries, by `secret` name. */
  auth?: Readonly<Record<string, KeyedTokenSource>>;
  /** No data either way for this long ends the request. Default `DEFAULT_KEYED_IDLE_TIMEOUT_MS`. */
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
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function placementOf(placement: AuthPlacement | undefined): { header: string; scheme: string | undefined } {
  const header = (placement?.header ?? "authorization").toLowerCase();
  if (!HEADER_NAME_RE.test(header)) throw new KeyedFetchError("credential_header", `${JSON.stringify(placement?.header)} is not a header name`);
  const scheme = placement?.scheme ?? (header === "authorization" ? "Bearer" : undefined);
  if (scheme !== undefined && !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(scheme)) throw new KeyedFetchError("credential_header", `${JSON.stringify(scheme)} is not an auth scheme`);
  return { header, scheme };
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

export function createKeyedFetch(config: KeyedFetchConfig): KeyedFetch {
  const hosts = parseNetworkHosts(config.hosts);
  const auth = config.auth ?? {};
  const authNames = Object.keys(auth);
  const idleMs = config.idleTimeoutMs ?? DEFAULT_KEYED_IDLE_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const followRedirects = config.followRedirects !== false;
  const platformFetch = config.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  const checkUrl = (raw: string, hop: "request" | "redirect"): URL => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new KeyedFetchError(hop === "request" ? "insecure_url" : "redirect_refused", `the ${hop === "request" ? "request URL" : "redirect target"} is not an absolute URL`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new KeyedFetchError(hop === "request" ? "insecure_url" : "redirect_refused", `the ${hop === "request" ? "request URL" : "redirect target"} carries user info`);
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
    let url = checkUrl(rawUrl, "request");

    let source: KeyedTokenSource | undefined;
    if (options.auth === false) source = undefined;
    else if (typeof options.auth === "string") {
      source = Object.prototype.hasOwnProperty.call(auth, options.auth) ? auth[options.auth] : undefined;
      if (source === undefined) throw new KeyedFetchError("unknown_auth", `this plugin has no auth entry named ${JSON.stringify(options.auth)}`);
    } else if (authNames.length === 1) source = auth[authNames[0]!];
    else if (authNames.length > 1) throw new KeyedFetchError("ambiguous_auth", `this plugin has ${authNames.length} auth entries; name the one to add`);

    const placement = placementOf(options.placement);
    let headers = new Headers(init.headers ?? {});
    if (source !== undefined && headers.has(placement.header)) {
      throw new KeyedFetchError("credential_header", `the request sets ${placement.header} itself; the keyed fetch adds the key there`);
    }
    let token = source === undefined ? null : await source.current();
    if (source !== undefined && token === null) throw new KeyedFetchError("no_credential", "no key or token is stored for this plugin's auth entry; sign in first");

    const signal = init.signal;
    if (signal?.aborted === true) throw new KeyedFetchError("aborted", "the request was aborted before it was sent");

    // ONE controller for the whole exchange, every hop and the body: the watchdog and the caller abort it.
    const controller = new AbortController();
    let idleFired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        idleFired = true;
        controller.abort();
      }, idleMs);
    };
    const pause = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const finish = (): void => {
      pause();
      signal?.removeEventListener("abort", onCallerAbort);
    };
    const failure = (err: unknown): KeyedFetchError => {
      if (idleFired) return new KeyedFetchError("idle_timeout", `no data moved for ${idleMs} ms`);
      if (signal?.aborted === true) return new KeyedFetchError("aborted", "the request was aborted by the caller");
      if (err instanceof KeyedFetchError) return err;
      return new KeyedFetchError("network", err instanceof Error ? err.message : String(err));
    };

    let method = (init.method ?? "GET").toUpperCase();
    let body: KeyedFetchInit["body"] = init.body ?? undefined;
    const streamedBody = body instanceof ReadableStream;
    if (streamedBody) body = tapUpload(body as ReadableStream<Uint8Array>, arm);
    let keyOn = source !== undefined;
    let retried = false;
    let hops = 0;

    try {
      for (;;) {
        const sent = new Headers(headers);
        if (keyOn && token !== null) sent.set(placement.header, placement.scheme === undefined ? token.value : `${placement.scheme} ${token.value}`);
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
        pause();

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

        if (response.status === 401 && keyOn && token !== null && source !== undefined && !retried && !streamedBody) {
          retried = true;
          const next = await source.newer(token.generation);
          if (next !== null && next.generation > token.generation) {
            void response.body?.cancel().catch(() => {});
            token = next;
            continue;
          }
        }

        if (response.body === null) {
          finish();
          return response;
        }
        // The body: the watchdog runs only while a read is pending, so a caller that is busy with the
        // last chunk is never mistaken for a silent server.
        const reader = response.body.getReader();
        const tapped = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            arm();
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
              chunk = await reader.read();
            } catch (err) {
              finish();
              streamController.error(failure(err));
              return;
            }
            pause();
            if (chunk.done) {
              finish();
              streamController.close();
              return;
            }
            streamController.enqueue(chunk.value);
          },
          cancel(reason) {
            finish();
            void reader.cancel(reason).catch(() => {});
          },
        });
        return new Response(tapped, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
    } catch (err) {
      finish();
      controller.abort();
      throw failure(err);
    }
  };
}
