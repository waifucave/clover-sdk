// THE PIN on the model adapter interface: its version, its members, and its whole declaration closure.
// A change to any member list below fails `tsc` (the typecheck job); a change anywhere in the closure
// (review S6: `TurnRequest`, `ProviderEvent`, `ConnectionProfile`, `CredentialStatus`, `ModelCatalogResult`,
// the catalog row...) fails the snapshot test until `interface.snapshot.txt` is regenerated on purpose
// (`UPDATE_INTERFACE_SNAPSHOT=1 bun test src/adapter-interface/interface.test.ts`). A change that is not
// purely additive must bump MODEL_ADAPTER_INTERFACE_VERSION as well.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODEL_ADAPTER_INTERFACE_VERSION, type AdapterContext, type AdapterDiscoveryContext, type KeyPlacement, type KeyedAuthEntry, type KeyedFetchInit, type KeyedFetchOptions, type ModelAdapter } from "./index.ts";
import { adapterInterfaceClosure } from "./interface-snapshot.test-support.ts";

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const pins: [
  Exactly<keyof ModelAdapter, "interfaceVersion" | "id" | "version" | "family" | "protocol" | "validateCredential" | "listModels" | "streamTurn" | "countTokens" | "mapEffort" | "capabilities">,
  Exactly<keyof AdapterContext, "connection" | "fetch" | "secrets" | "stallTimeoutMs" | "log">,
  Exactly<Exclude<keyof AdapterDiscoveryContext, keyof AdapterContext>, "signal" | "limits">,
  Exactly<keyof KeyedFetchInit, "method" | "headers" | "body" | "signal">,
  // A request names WHICH key and how long silence may last; never where the key goes (review B1).
  Exactly<keyof KeyedFetchOptions, "auth" | "idleTimeoutMs">,
  Exactly<KeyPlacement["header"], "authorization" | "x-api-key" | "api-key" | "x-goog-api-key">,
  Exactly<keyof KeyedAuthEntry, "source" | "placement">,
  // No credential store and no reference: the members that made an adapter hold the key are gone.
  Exactly<Extract<keyof AdapterContext, "credentials" | "authRef">, never>,
] = [true, true, true, true, true, true, true, true];

test("the model adapter interface is version 1, with exactly the pinned members", () => {
  expect(MODEL_ADAPTER_INTERFACE_VERSION).toBe(1);
  expect(pins.every((pinned) => pinned)).toBe(true);
});

test("its declaration closure matches the committed snapshot (a change here is a contract change)", () => {
  const path = fileURLToPath(new URL("./interface.snapshot.txt", import.meta.url));
  const now = adapterInterfaceClosure();
  if (process.env["UPDATE_INTERFACE_SNAPSHOT"] === "1" || !existsSync(path)) writeFileSync(path, now);
  expect(now).toBe(readFileSync(path, "utf8"));
  // Not vacuous: the closure reaches the types the review named.
  for (const name of ["TurnRequest", "ProviderEvent", "ConnectionProfile", "CredentialStatus", "ModelCatalogResult", "WinterModelDescriptor"]) expect(now).toContain(` ${name}\n`);
}, 60_000);
