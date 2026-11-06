// The model adapter interface (Clover spec §3.3, §5.2, §5.4): the keyed fetch, the context an adapter
// is handed, the bridges to today's `ProviderAdapter`, and a process of an adapter's own for one that
// signs with its secret. See `types.ts` for the contract itself.
export { MODEL_ADAPTER_INTERFACE_VERSION } from "./types.ts";
export type { AdapterContext, AdapterDiscoveryContext, AdapterSecrets, KeyedFetch, KeyedFetchInit, KeyedFetchOptions, ModelAdapter } from "./types.ts";
export { AUTH_SCHEME_RE, DEFAULT_KEYED_IDLE_TIMEOUT_MS, DEFAULT_KEY_PLACEMENT, KEY_HEADERS, KeyedFetchError, MAX_KEYED_IDLE_TIMEOUT_MS, MIN_KEYED_IDLE_TIMEOUT_MS, clampKeyedIdleTimeoutMs, createKeyedFetch } from "./keyed-fetch.ts";
export type { KeyHeader, KeyPlacement, KeyedAuthEntry, KeyedFetchConfig, KeyedFetchErrorCode, KeyedToken, KeyedTokenSource } from "./keyed-fetch.ts";
export { hostAllowed, isLoopbackHost, parseNetworkHost, parseNetworkHosts } from "./network-hosts.ts";
export type { NetworkHost } from "./network-hosts.ts";
export { keyedValueOf, tokenSourceFromCredentialStore } from "./token-source.ts";
export { modelAdapterFromSigningAdapter, providerAdapterFromModelAdapter } from "./bridge.ts";
export type { ModelAdapterBridgeOptions, SigningAdapterOptions } from "./bridge.ts";
export { serveModelAdapterProcess, spawnModelAdapterProcess } from "./own-process.ts";
export type { ModelAdapterProcess, ModelAdapterProcessOptions, ServeModelAdapterProcessIo } from "./own-process.ts";
export { BEDROCK_SECRET, bedrockNetworkHosts, bedrockAdapterProcessCommand, bedrockSigningModelAdapter, runBedrockAdapterProcess, spawnBedrockAdapterProcess } from "./bedrock-process.ts";
export type { BedrockAdapterProcessOptions } from "./bedrock-process.ts";
export { keyedTransport, modelAdapterFromProviderAdapter } from "./keyed-bridge.ts";
export type { KeyedBridgeOptions } from "./keyed-bridge.ts";
export {
  HOST_MODEL_ADAPTER_ABANDON_MS,
  HOST_MODEL_ADAPTER_CONTROL_TIMEOUT_MS,
  HOST_MODEL_ADAPTER_NEXT_TIMEOUT_MS,
  HOST_MODEL_ADAPTER_SUBTYPES,
  createHostModelAdapterServer,
  fromWireProviderError,
  hostModelAdapterOf,
  hostServedProviderAdapter,
  rowDerivedCapabilities,
  rowDerivedMapEffort,
  toWireProviderError,
} from "./host-served.ts";
export type {
  HostControlAnswer,
  HostModelAdapter,
  HostModelAdapterBatch,
  HostModelAdapterContext,
  HostModelAdapterMethod,
  HostModelAdapterOpen,
  HostModelAdapterSender,
  HostServedAdapterIdentity,
  WireProviderError,
} from "./host-served.ts";
export { catalogOfModelPlugin, familyModelAdapter, materialOfSecret, modelAdapterHandlers } from "./plugin-handlers.ts";
export type { FamilyModelAdapterOptions, ModelAdapterDescription, ModelAdapterHandlers, ModelCallArgs, ModelHandlerContext } from "./plugin-handlers.ts";
