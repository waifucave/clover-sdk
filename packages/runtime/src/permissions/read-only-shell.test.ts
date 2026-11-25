// `isReadOnlyShellCommand` (exported from the runtime's root for a host's own shell tool) and the evaluator's
// default-mode read-only pre-approval of the built-in Bash tool are ONE decision. One table, both callers: for every
// row the export's answer is the row's, and a built-in Bash call of that command is allowed with no prompt exactly
// when the row says read-only. Hostile rows are pinned to false; a few benign-looking ones are pinned only to the two
// callers agreeing, so this file states what the rule IS without restating its whole vocabulary.
import { describe, expect, test } from "bun:test";
import { isReadOnlyShellCommand as fromRoot } from "../index.ts";
import { evaluate, isReadOnlyShellCommand, NO_OPINION_HOOK_STAGE, REAL_SPECIAL_CHECKS, type AutoEngine, type EvaluationContext, type PermissionCall } from "./evaluator.ts";
import { PARSE_LIMIT } from "./grammar.ts";
import { emptyRuleSet } from "./ruleset.ts";

const CWD = "/work/repo";

/** [command, read-only?] -- `undefined` means "whatever the rule says, both callers must say it". */
const TABLE: Array<[string, boolean | undefined]> = [
  // Read-only.
  ["ls -la", true],
  ["ls", true],
  ["cat a.txt", true],
  ["git status", true],
  ["git log --oneline -5", true],
  ["ls && cat a.txt", true],
  ["ls | grep x", true],
  ["timeout 5 ls -la", true],
  // A writer, a runner or a network call.
  ["rm -rf build", false],
  ["git push", false],
  ["git commit -m x", false],
  ["find . -delete", false],
  ["curl https://example.com", false],
  // Command and process substitution: the body runs.
  ["ls $(rm -rf ~)", false],
  ["cat `rm x`", false],
  ["cat <(rm x)", false],
  ["echo $(touch f)", false],
  // Redirection.
  ["ls > out.txt", false],
  ["cat a >> b", false],
  ["git log > /tmp/out", false],
  ["echo hi > /etc/passwd", false],
  // Chains with a writer anywhere.
  ["ls; rm x", false],
  ["ls && rm x", false],
  ["ls || rm x", false],
  ["cat a | tee b", false],
  ["ls\nrm x", false],
  // Assignments and env.
  ["LD_PRELOAD=/tmp/evil.so cat /etc/passwd", false],
  ["env FOO=1 rm x", false],
  ["env FOO=1 ls", undefined],
  ["FOO=1 ls", undefined],
  // Here-documents: an unquoted body's substitutions run; a writer fed one is a writer.
  ["cat <<EOF\n$(rm x)\nEOF", false],
  ["tee f <<EOF\nx\nEOF", false],
  ["cat <<'EOF'\nhello\nEOF", undefined],
  // Aliases and functions: defining one is not a read, and the call after it runs the definition.
  ["alias ls='rm -rf ~'; ls", false],
  ["f() { rm x; }; f", false],
  // Unparseable.
  ["cat 'foo && rm -rf /", false],
  ["ls $(", false],
  ["", false],
];

function ctx(prompts: PermissionCall[]): EvaluationContext {
  return {
    policy: { mode: "default", version: 0, rules: emptyRuleSet() },
    cwd: CWD,
    sessionRoot: CWD,
    home: "/synthetic/home/tester",
    trustedWorkspace: false,
    sessionBypassEnabled: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: {
      async prompt(c) {
        prompts.push(c);
        return { decision: "deny", message: "asked" };
      },
    },
    autoEngine: { async classify() { return { verdict: "ask", fallbackToPrompt: true }; } } as unknown as AutoEngine,
    specialChecks: REAL_SPECIAL_CHECKS,
  };
}

/** The evaluator's answer: a built-in Bash call of `command` in default mode, allowed with no prompt. */
async function evaluatorSaysReadOnly(command: string): Promise<boolean> {
  const prompts: PermissionCall[] = [];
  const record = await evaluate({ toolName: "Bash", input: { command }, toolUseId: "t1" }, ctx(prompts));
  return record.decision === "allow" && prompts.length === 0;
}

describe("isReadOnlyShellCommand answers exactly as the evaluator's pre-approval", () => {
  for (const [command, expected] of TABLE) {
    test(JSON.stringify(command), async () => {
      const exported = isReadOnlyShellCommand(command);
      expect(fromRoot(command)).toBe(exported);
      expect(await evaluatorSaysReadOnly(command)).toBe(exported);
      if (expected !== undefined) expect(exported).toBe(expected);
    });
  }
});

describe("bounded time on very long input", () => {
  test("over the parser's limit: not read-only, at once", () => {
    const huge = "ls " + "a".repeat(PARSE_LIMIT);
    const started = performance.now();
    expect(isReadOnlyShellCommand(huge)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a long chain just under the limit is judged in bounded time", () => {
    const chain = Array.from({ length: Math.floor(PARSE_LIMIT / 10) }, () => "ls -la").join(" && ");
    expect(chain.length).toBeLessThanOrEqual(PARSE_LIMIT);
    const started = performance.now();
    isReadOnlyShellCommand(chain);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("deep nesting is refused, not recursed without end", () => {
    const deep = "echo " + "$(".repeat(100) + "ls" + ")".repeat(100);
    expect(isReadOnlyShellCommand(deep)).toBe(false);
  });

  test("a non-string is not read-only", () => {
    expect(isReadOnlyShellCommand(undefined as unknown as string)).toBe(false);
  });
});
