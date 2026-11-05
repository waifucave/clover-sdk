// A keyed-fetch token source over a `CredentialStore`: how today's runtime (and the daemon, until the
// plugin API's own `net.fetch` exists) feeds the keyed fetch from a store and a reference.
//
// GENERATIONS. Each distinct value the store hands out gets the next generation number, so "newer than
// the token that drew the 401" is a comparison, never a guess. `newer()` asks a store that is renewed
// by someone else (`CredentialStore.refresh`, the host-brokered session of WS-25 §7) for fresh
// material; any other store is read again, which finds a key the user replaced in the meantime.
//
// Only material that is a key or a token can be added to a request. AWS keys and a GCP service
// account are SIGNING material: an adapter that needs them runs in a process of its own (§5.2) and
// reads them with `secrets.get`, so asking for them here is refused, typed.
import type { CredentialMaterial, CredentialRef, CredentialStore } from "../types.ts";
import { KeyedFetchError, type KeyedToken, type KeyedTokenSource } from "./keyed-fetch.ts";

/** The value a key or token material puts on the wire, or a typed refusal for signing material. */
export function keyedValueOf(material: CredentialMaterial): string {
  switch (material.kind) {
    case "api-key":
      return material.key;
    case "bearer":
      return material.token;
    case "oauth":
      return material.accessToken;
    case "gcp-access-token":
      return material.token;
    default:
      throw new KeyedFetchError("no_credential", `a credential of kind "${material.kind}" signs requests and cannot be added to one; its adapter runs in a process of its own and reads it with secrets.get`);
  }
}

export function tokenSourceFromCredentialStore(store: CredentialStore, ref: CredentialRef): KeyedTokenSource {
  let generation = 0;
  let last: string | undefined;
  const observe = (material: CredentialMaterial): KeyedToken => {
    const value = keyedValueOf(material);
    if (value !== last) {
      last = value;
      generation += 1;
    }
    return { value, generation };
  };
  return {
    async current() {
      const material = await store.get(ref);
      return material === null ? null : observe(material);
    },
    async newer(after) {
      const material = store.refresh !== undefined && ref.kind === "keychain" ? await store.refresh(ref) : await store.get(ref);
      if (material === null) return null;
      const token = observe(material);
      return token.generation > after ? token : null;
    },
  };
}
