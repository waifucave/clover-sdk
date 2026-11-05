// The model adapter interface (Clover spec §3.3, §5.2, §5.4): the keyed fetch, the context an adapter
// is handed, the bridges to today's `ProviderAdapter`, and a process of an adapter's own for one that
// signs with its secret. See `types.ts` for the contract itself.
export { MODEL_ADAPTER_INTERFACE_VERSION } from "./types.ts";
export type { AdapterContext, AdapterDiscoveryContext, AdapterSecrets, KeyedFetch, KeyedFetchInit, KeyedFetchOptions, ModelAdapter } from "./types.ts";
export { DEFAULT_KEYED_IDLE_TIMEOUT_MS, DEFAULT_KEY_PLACEMENT, KEY_HEADERS, KeyedFetchError, createKeyedFetch } from "./keyed-fetch.ts";
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
