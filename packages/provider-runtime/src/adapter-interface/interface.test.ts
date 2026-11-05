// THE PIN on the model adapter interface: its version and its members. A change to any member list
// below fails `tsc` (the typecheck job) before it reaches a plugin; a change that is not purely
// additive must bump MODEL_ADAPTER_INTERFACE_VERSION as well.
import { expect, test } from "bun:test";
import { MODEL_ADAPTER_INTERFACE_VERSION, type AdapterContext, type AdapterDiscoveryContext, type AuthPlacement, type KeyedFetchInit, type KeyedFetchOptions, type ModelAdapter } from "./index.ts";

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const pins: [
  Exactly<keyof ModelAdapter, "interfaceVersion" | "id" | "version" | "family" | "protocol" | "validateCredential" | "listModels" | "streamTurn" | "countTokens" | "mapEffort" | "capabilities">,
  Exactly<keyof AdapterContext, "connection" | "fetch" | "secrets" | "stallTimeoutMs" | "log">,
  Exactly<Exclude<keyof AdapterDiscoveryContext, keyof AdapterContext>, "signal" | "limits">,
  Exactly<keyof KeyedFetchInit, "method" | "headers" | "body" | "signal">,
  Exactly<keyof KeyedFetchOptions, "auth" | "placement">,
  Exactly<keyof AuthPlacement, "header" | "scheme">,
  // No credential store and no reference: the members that made an adapter hold the key are gone.
  Exactly<Extract<keyof AdapterContext, "credentials" | "authRef">, never>,
] = [true, true, true, true, true, true, true];

test("the model adapter interface is version 1, with exactly the pinned members", () => {
  expect(MODEL_ADAPTER_INTERFACE_VERSION).toBe(1);
  expect(pins.every((pinned) => pinned)).toBe(true);
});
