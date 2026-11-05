// A plugin's `network:` hosts (spec §5.4's capability table): "a name, with `:port` if needed, or `*.`
// and a domain for its subdomains". The keyed fetch reaches only these.
//
// THE RULES, each one a refusal rather than a guess:
//   * a name matches its own host on the scheme's default port; any other port must be named
//     (`localhost:11434`), so declaring a host never opens every service on it;
//   * `*.example.com` matches every subdomain of `example.com` at any depth, and never `example.com`
//     itself (declare both when both are meant);
//   * names compare in lowercase, and an IPv6 literal is written in brackets (`[::1]:8080`);
//   * an entry that is not one of those shapes is refused when the fetch is built, never ignored.

export interface NetworkHost {
  /** Lowercase host name or address (IPv6 without brackets), or the domain under `*.`. */
  host: string;
  /** `*.` was given: subdomains of `host`, never `host` itself. */
  wildcard: boolean;
  /** The named port; absent means the URL scheme's default port only. */
  port?: number;
}

const NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Parses one `network:` entry. Returns a reason string for an entry that is not a host. */
export function parseNetworkHost(entry: string): NetworkHost | string {
  const raw = entry.trim().toLowerCase();
  if (raw.length === 0) return "an empty network host";
  let rest = raw;
  let wildcard = false;
  if (rest.startsWith("*.")) {
    wildcard = true;
    rest = rest.slice(2);
  }
  let host: string;
  let portText: string | undefined;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return `${JSON.stringify(entry)}: an unclosed IPv6 literal`;
    host = rest.slice(1, close);
    const after = rest.slice(close + 1);
    if (after.length > 0) {
      if (!after.startsWith(":")) return `${JSON.stringify(entry)}: unexpected text after the IPv6 literal`;
      portText = after.slice(1);
    }
    if (wildcard) return `${JSON.stringify(entry)}: a wildcard applies to a domain, not an address`;
    if (!/^[0-9a-f:.]+$/.test(host) || !host.includes(":")) return `${JSON.stringify(entry)}: not an IPv6 literal`;
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon >= 0) {
      host = rest.slice(0, colon);
      portText = rest.slice(colon + 1);
    } else {
      host = rest;
    }
    if (!NAME_RE.test(host)) return `${JSON.stringify(entry)}: not a host name (letters, digits, hyphens and dots)`;
  }
  if (portText === undefined) return { host, wildcard };
  if (!/^[0-9]{1,5}$/.test(portText)) return `${JSON.stringify(entry)}: the port is not a number`;
  const port = Number(portText);
  if (port < 1 || port > 65535) return `${JSON.stringify(entry)}: the port is out of range`;
  return { host, wildcard, port };
}

/** Parses every entry, refusing the list on the first bad one (with its reason). */
export function parseNetworkHosts(entries: readonly string[]): NetworkHost[] {
  return entries.map((entry) => {
    const parsed = parseNetworkHost(entry);
    if (typeof parsed === "string") throw new TypeError(`network host refused: ${parsed}`);
    return parsed;
  });
}

const DEFAULT_PORTS: Record<string, number> = { "https:": 443, "http:": 80 };

/** The URL's host, lowercase, with an IPv6 literal's brackets removed. */
export function urlHost(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True when `url` is one of `hosts`, port included. */
export function hostAllowed(url: URL, hosts: readonly NetworkHost[]): boolean {
  const host = urlHost(url);
  const port = url.port === "" ? DEFAULT_PORTS[url.protocol] : Number(url.port);
  if (port === undefined) return false;
  for (const entry of hosts) {
    const portOk = entry.port === undefined ? port === DEFAULT_PORTS[url.protocol] : port === entry.port;
    if (!portOk) continue;
    if (entry.wildcard ? host.endsWith(`.${entry.host}`) : host === entry.host) return true;
  }
  return false;
}

/** Loopback: the one place plain `http:` may go (a model served on this computer, a test's fake). */
export function isLoopbackHost(url: URL): boolean {
  const host = urlHost(url);
  return host === "localhost" || host === "::1" || /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(host);
}
