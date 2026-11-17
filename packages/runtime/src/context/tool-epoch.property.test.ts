// Generated sequences over the tool epoch's pure diff: random tool events across a session, and after EVERY
// step the provider's rule must hold -- a `reference` names only a tool `tools` declares with `defer_loading`
// (the stricter reading; see tool-epoch.ts), or the diff is a `new-epoch`. No dependency: a small seeded
// generator (mulberry32), so a failure prints the seed and reproduces exactly.
import { describe, expect, test } from "bun:test";
import type { ProviderMessage, ProviderToolSpec } from "../engine.ts";
import { attachmentMessage } from "./attachments.ts";
import { activeToolEpoch, diffToolState, epochChangeMessages, epochToolsFor, foldToolState, toolDefinitionKey, type ToolChangeMechanism, type ToolChangesAttachment, type ToolEpochAttachment } from "./tool-epoch.ts";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = ["a", "b", "c", "d", "e", "f"];

function runSequence(seed: number, mechanism: "anthropic-reference" | "anthropic-inline"): void {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const version = new Map<string, number>();
  const deferredName = new Map<string, boolean>();
  const live = new Map<string, ProviderToolSpec>();
  const mk = (name: string): ProviderToolSpec => ({ name, description: `${name} v${version.get(name) ?? 0}`, inputSchema: { type: "object" }, ...(deferredName.get(name) === true ? { deferLoading: true } : {}) });
  const put = (name: string): void => void live.set(name, mk(name));
  const liveList = (): ProviderToolSpec[] => [...live.values()].sort((x, y) => (x.name < y.name ? -1 : 1));
  for (const name of POOL.slice(0, 4)) {
    deferredName.set(name, rand() < 0.4);
    put(name);
  }
  put("zz_anchor"); // one eager tool always lives, as the real registry always has
  const trace: string[] = [];
  const fail = (why: string): never => {
    throw new Error(`seed ${seed} (${mechanism}): ${why}\n  trace: ${trace.join(" | ")}`);
  };
  const epochMessage = (tools: ProviderToolSpec[]): ProviderMessage => attachmentMessage({ type: "tool_epoch", mechanism, modelKey: "m", tools } satisfies ToolEpochAttachment)!;
  let history: ProviderMessage[] = [{ role: "user", content: "go" }, epochMessage(epochToolsFor(liveList(), mechanism))];
  // Deferred tools the host's ToolSearch surfaced (`loadedTools`): the engine surfaces ANY live deferred
  // tool by `tool_reference`, so one is callable through its declaration. A new epoch retires them.
  const referenced = new Set<string>();
  const stateNow = () => {
    const active = activeToolEpoch(history, mechanism, "m")!;
    return foldToolState(active.epoch, epochChangeMessages(history, active.index, mechanism), referenced);
  };
  for (let step = 0; step < 14; step++) {
    // One turn: one to three events.
    for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
      const absent = POOL.filter((t) => !live.has(t));
      const present = [...live.keys()].filter((t) => t !== "zz_anchor");
      const kind = pick(["remove", "back-same", "back-changed", "new", "change", "flip", "surface"]);
      if (kind === "remove" && present.length > 0) {
        const t = pick(present);
        live.delete(t);
        trace.push(`-${t}`);
      } else if ((kind === "back-same" || kind === "back-changed" || kind === "new") && absent.length > 0) {
        const t = pick(absent);
        if (kind === "back-changed" || !version.has(t)) version.set(t, (version.get(t) ?? 0) + 1);
        if (!version.has(t) || kind === "new") deferredName.set(t, rand() < 0.4);
        put(t);
        trace.push(`+${t}${kind === "back-changed" ? "*" : ""}${deferredName.get(t) ? "d" : ""}`);
      } else if (kind === "flip" && present.length > 0) {
        // A PRESENT tool moves between eager and on demand (a setting changed mid-session).
        const t = pick(present);
        deferredName.set(t, deferredName.get(t) !== true);
        put(t);
        trace.push(`^${t}${deferredName.get(t) ? "d" : "e"}`);
      } else if (kind === "surface") {
        const hidden = [...live.values()].filter((t) => t.deferLoading === true);
        if (hidden.length > 0) {
          const t = pick(hidden);
          referenced.add(t.name);
          trace.push(`?${t.name}`);
        }
      } else if (kind === "change" && present.length > 0) {
        const t = pick(present);
        version.set(t, (version.get(t) ?? 0) + 1);
        put(t);
        trace.push(`~${t}`);
      }
    }
    const state = stateNow();
    const diff = diffToolState(liveList(), state, mechanism);
    trace.push(diff.kind === "same" ? "same" : diff.kind);
    if (diff.kind === "new-epoch") {
      history = [...history, epochMessage(epochToolsFor(liveList(), mechanism))];
      referenced.clear();
    } else if (diff.kind === "change") {
      const declaredAfter = new Map(state.declared.map((t) => [t.name, t] as const));
      for (const d of diff.change.declare) {
        if (d.deferLoading !== true) fail(`a late declaration of "${d.name}" is not deferred`);
        declaredAfter.set(d.name, d);
      }
      for (const a of diff.change.add) {
        if (a.type === "reference") {
          const d = declaredAfter.get(a.name);
          if (d === undefined) fail(`reference to undeclared "${a.name}"`);
          if (d!.deferLoading !== true) fail(`reference to "${a.name}", which is declared without defer_loading`);
        } else if (mechanism !== "anthropic-inline") fail(`a definition of "${a.name}" on a reference-only row`);
      }
      history = [...history, attachmentMessage({ type: "tool_changes", mechanism, ...diff.change } satisfies ToolChangesAttachment)!];
    }
    // After the step: some eager tool is declared; the callable set is exactly the live eager tools (plus
    // none that was withdrawn); and nothing is left to change (the diff converges).
    const after = stateNow();
    if (!after.declared.some((t) => t.deferLoading !== true)) fail("no non-deferred tool is declared");
    for (const spec of liveList()) {
      if (spec.deferLoading === true) continue;
      const have = after.available.get(spec.name);
      if (have === undefined) fail(`live tool "${spec.name}" is not callable after the step`);
      else if (toolDefinitionKey(have!) !== toolDefinitionKey(spec)) fail(`live tool "${spec.name}" has a stale definition after the step`);
    }
    // Every live deferred tool: its declaration is deferred (ToolSearch may surface it by reference), or it is
    // available with the current definition (an eager tool that stays callable while set to on demand).
    for (const spec of liveList()) {
      if (spec.deferLoading !== true) continue;
      const declaration = after.declared.find((t) => t.name === spec.name);
      const have = after.available.get(spec.name);
      if (declaration !== undefined && declaration.deferLoading === true) {
        if (have !== undefined && toolDefinitionKey(have) !== toolDefinitionKey(spec)) fail(`live deferred tool "${spec.name}" is callable with a stale definition`);
        continue;
      }
      if (declaration === undefined) fail(`live deferred tool "${spec.name}" is not declared`);
      else if (have === undefined || toolDefinitionKey(have) !== toolDefinitionKey(spec)) fail(`live deferred tool "${spec.name}" has an eager declaration and is hidden or stale`);
    }
    const liveNames = new Set(liveList().map((t) => t.name));
    for (const name of after.available.keys()) if (!liveNames.has(name)) fail(`withdrawn tool "${name}" is still callable`);
    { const again = diffToolState(liveList(), after, mechanism); if (again.kind !== "same") fail(`the diff does not converge: ${JSON.stringify(again)} live=${JSON.stringify(liveList().map((t) => [t.name, t.description, t.deferLoading === true]))} declared=${JSON.stringify(after.declared.map((t) => [t.name, t.description, t.deferLoading === true]))}`); }
  }
}

describe("tool epoch: generated event sequences (seeded)", () => {
  for (const mechanism of ["anthropic-reference", "anthropic-inline"] as const satisfies readonly ToolChangeMechanism[]) {
    test(`${mechanism}: 3000 sequences keep every reference on a deferred declaration and the callable set exact`, () => {
      for (let seed = 1; seed <= 3000; seed++) runSequence(seed, mechanism);
    });
  }
  test("the generator is reproducible", () => {
    expect(() => runSequence(42, "anthropic-inline")).not.toThrow();
  });
});
