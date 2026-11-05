// BEDROCK IN A PROCESS OF ITS OWN (Clover spec §5.2): the one shipped adapter that SIGNS with its secret
// (AWS SigV4), and so the reference for every adapter that must.
//
// The adapter is today's Bedrock Converse adapter, unchanged: in its own process it reads the plugin's
// `aws` secret through `secrets.get` (`modelAdapterFromSigningAdapter`) and signs there, and its
// requests reach only the plugin's `network:` hosts. The host side (`spawnBedrockAdapterProcess`) runs
// only the adapter's pure half (identity, effort mapping, capabilities) and answers the process's
// `secrets.get`; it never signs and the shared plugin host never sees the keys.
import { fileURLToPath } from "node:url";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { identityHeaderLookup } from "../identity.ts";
import { descriptorLookupForAdapter } from "../adapters/index.ts";
import { BEDROCK_ADAPTER_ID, createBedrockConverseAdapter, type BedrockAdapter } from "../adapters/bedrock/index.ts";
import { modelAdapterFromSigningAdapter } from "./bridge.ts";
import { serveModelAdapterProcess, spawnModelAdapterProcess, type ModelAdapterProcess } from "./own-process.ts";
import type { AdapterSecrets, ModelAdapter } from "./types.ts";

/** The secret the Bedrock adapter signs with: AWS material (`{ kind: "aws", accessKeyId, secretAccessKey, sessionToken? }`). */
export const BEDROCK_SECRET = "aws";

const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/;

/**
 * Where Bedrock answers in `region`: `bedrock-runtime.<region>.amazonaws.com` (turns) and
 * `bedrock.<region>.amazonaws.com` (discovery). Exactly those two, never `*.amazonaws.com`, which would
 * cover every AWS customer's buckets and gateways too. Throws TypeError for a malformed region.
 */
export function bedrockNetworkHosts(region: string): string[] {
  if (!AWS_REGION_RE.test(region)) throw new TypeError(`${JSON.stringify(region)} is not an AWS region`);
  return [`bedrock-runtime.${region}.amazonaws.com`, `bedrock.${region}.amazonaws.com`];
}

/** The shipped Bedrock adapter over the bundled catalog: what both halves are built from. */
function shippedBedrockAdapter(): BedrockAdapter {
  const catalog = loadCatalog();
  return createBedrockConverseAdapter({ descriptors: descriptorLookupForAdapter(catalog, BEDROCK_ADAPTER_ID), identityHeaders: identityHeaderLookup(catalog) });
}

/** The process side: the Bedrock adapter as a model adapter that signs with `secrets.get(BEDROCK_SECRET)`. */
export function bedrockSigningModelAdapter(): ModelAdapter {
  return modelAdapterFromSigningAdapter(shippedBedrockAdapter(), { secret: BEDROCK_SECRET });
}

/** The process's main: serves the Bedrock adapter over stdin/stdout until stdin closes. */
export async function runBedrockAdapterProcess(): Promise<void> {
  await serveModelAdapterProcess(bedrockSigningModelAdapter);
}

/** The default command: this runtime running `bedrock-process-main.ts`. A compiled host passes its own. */
export function bedrockAdapterProcessCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL("./bedrock-process-main.ts", import.meta.url))];
}

export interface BedrockAdapterProcessOptions {
  /** The plugin's own secrets; `secrets.get("aws")` must answer with AWS material. */
  secrets: AdapterSecrets;
  /** The AWS region the process reaches; its hosts are `bedrockNetworkHosts(region)`. */
  region?: string;
  /** Instead of `region`'s hosts (a test's loopback fake). One of the two is required. */
  hosts?: readonly string[];
  /** Default `bedrockAdapterProcessCommand()`. */
  command?: readonly string[];
  stderr?: (line: string) => void;
}

function missingRegion(): never {
  throw new TypeError("spawnBedrockAdapterProcess needs the AWS region (or explicit hosts): its process reaches only that region's Bedrock hosts");
}

/** The host side: starts the Bedrock adapter's own process and returns it as a model adapter. */
export function spawnBedrockAdapterProcess(options: BedrockAdapterProcessOptions): ModelAdapterProcess {
  const local = shippedBedrockAdapter();
  return spawnModelAdapterProcess({
    command: options.command ?? bedrockAdapterProcessCommand(),
    local,
    secrets: options.secrets,
    hosts: options.hosts ?? (options.region !== undefined ? bedrockNetworkHosts(options.region) : missingRegion()),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
  });
}
