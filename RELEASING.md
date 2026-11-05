# Releasing

A release is **two publishes to two registries**, driven by pushing a `v<version>` tag. Nothing here
is optional, and two of the rules exist because getting them wrong cannot be undone: neither GitHub
Packages nor npm lets a version be re-published.

## Pack and publish with **pnpm**, never with plain `npm`

`publishConfig.exports` is a **pnpm feature**. pnpm applies it at pack time — dropping the `bun`
condition, so the published manifest names only `dist/`. npm **ignores** it.

An `npm pack` or `npm publish` of these packages therefore produces a tarball whose manifest still
says `"bun": "./src/index.ts"` while `files` ships no `src/`. Measured: such a tarball installs
cleanly and imports fine **under Node**, and dies under **Bun** with
`Cannot find module '@waifucave/clover-provider-catalog'` — a package that looks healthy everywhere
except the runtime this SDK is built for. The three packages carrying workspace dependencies are
worse still: `workspace:*` survives into the manifest and `npm install` of the tarball is impossible.

Every publishable package therefore declares a `prepack` guard that **refuses a non-pnpm packer** with
that explanation. It runs under `npm pack` and `npm publish`, passes under `pnpm pack`/`pnpm publish`
(which is how `releasePack()` and both release jobs pack), and never runs on a consumer's install —
pnpm strips `scripts` from the packed manifest, so the published package carries no `prepack` at all.

`scripts/publish-npm-set.ts` is the one path that mixes the two deliberately: it **packs** through
`releasePack()` (pnpm, so the overrides apply) and **publishes** the resulting tarballs with
`npm publish`, because pnpm's recursive publish silently drops `--provenance`.

## The two registries

| Registry | Job | Packages | Credential |
| --- | --- | --- | --- |
| GitHub Packages | `publish` | all six | `secrets.GITHUB_TOKEN`, `packages: write` |
| public npm | `publish-npm` | the closure of the wrapper + the two harness roots + the wrapper's `optionalDependency` — all six today | `secrets.NPM_TOKEN`, `id-token: write` for provenance |

**GitHub Packages only, for now (0.0.63).** The owner chose GitHub Packages as the one registry for
now, and the repository has no `NPM_TOKEN`. The `npm-token` job reads only whether that secret exists,
and without it the npm job is **skipped as a whole**: no install, no gates, a green workflow, and the
version on GitHub Packages alone. The GitHub Packages job never waits on anything about npm. Adding the
secret later turns the npm leg on with no workflow change.

**Only a `v*` tag publishes.** Every job on the publish path (`publish`, `npm-token`, `publish-npm`)
carries `if: startsWith(github.ref, 'refs/tags/v')`, so a `workflow_dispatch` on a branch builds the
platform binary at most and publishes nothing. A dispatch at a `v*` tag ref is the re-drive below.

Neither registry is chosen on a command line. `--registry` sets only `registries.default`, and both
pnpm and npm consult the **scope** binding first — a committed `@waifucave:registry` line would
therefore beat it, which is why the project `.npmrc` pins nothing. Each job binds its own scope *and*
credential with `actions/setup-node` (`registry-url` + `scope`), and
`scripts/publish-routing.test.ts` proves the routing with real `npm publish --dry-run` runs.

## The scope is the repository owner's (0.0.63)

GitHub Packages binds an npm scope to the account that owns the repository: a workflow's
`GITHUB_TOKEN` can publish `@<owner>/*` from a repository that `<owner>` owns, and nothing else. This
repository moved from `yanlingLabs` to `waifucave`, so its packages moved with it: from 0.0.63 they
are `@waifucave/clover-*` (`clover-agent-sdk`, `clover-agent-runtime`, `clover-provider-catalog`,
`clover-provider-runtime`, `clover-provider-conformance`, `clover-conformance`, `clover-web`, and the
platform package `clover-agent-sdk-darwin-arm64`), and both publish jobs bind `scope: "@waifucave"`.
Publishing `@yanlinglabs/*` from here is refused by GitHub Packages, and the npm job, which waits on
it, never runs.

What the owner provides before the first `@waifucave` release:

- **npm:** the `waifucave` organization (or user) on npmjs.com owning the `@waifucave` scope, and an
  automation token with publish rights on it, stored as the repository secret `NPM_TOKEN`. The
  packages are new names on npm, so the first publish creates them (public, as the job publishes).
- **GitHub Packages:** nothing beyond the repository's own `GITHUB_TOKEN` (`packages: write`, already
  in the job), since `waifucave` owns the repository. A consumer's `.npmrc` line becomes
  `@waifucave:registry=https://npm.pkg.github.com`.

The `@yanlinglabs/winter-*` versions already published stay where they are; they are Winter's. A fix
Winter's hand-over release needs ships from a branch of the last `@yanlinglabs` release (`v0.0.62`,
before the C0 rename), with that branch's own names and scope, from a repository `yanlingLabs` owns (or
by npm alone, with a token that has publish rights on `@yanlinglabs`); this repository's workflow
cannot publish it.

## The darwin-arm64 platform package (P9a-3/P9a-4)

`@waifucave/clover-agent-sdk-darwin-arm64` ships the compiled `winter` runtime binary — the
artifact the wrapper spawns — as an `optionalDependency` of `@waifucave/clover-agent-sdk`. It is
bin-only: no `main`, no `types`, no `exports` at all, just `bin: { winter: "bin/winter" }`, gated on
`os: ["darwin"]` / `cpu: ["arm64"]` so a package manager that honours those fields (npm; `bun install`
partially — see below) simply does not fetch it on any other platform.

**Built ONLY on a macOS `arm64` runner.** `bun build --compile` targets the CURRENT host — it does not
cross-compile — so a `build-platform` job (`runs-on: macos-15`) exists in BOTH workflows: `ci.yml`
runs it on every push (no tag pin, and it runs the smoke's real EXECUTE path —
`smoke-installed.ts --runtime=bun` actually spawns the just-built binary, since `os`/`cpu` match on
that runner) so a broken darwin build fails long before a tag exists; `release.yml` runs the same
build, additionally checks the binary's own `--version` against the pushed tag, tars it (GitHub
Actions artifact uploads drop the executable bit, which is exactly why this matters), and uploads it
as one artifact. Both jobs assert `uname -s`/`uname -m` themselves rather than trusting the `macos-15`
label.

**Both publish jobs `needs: build-platform`, download that ONE artifact, and restore + verify it —
`chmod +x`, `test -x`, `file` reports a Mach-O 64-bit arm64 executable (both file(1) wordings: macOS `executable arm64`, ubuntu `arm64 executable`), `shasum -a 256 -c` against the
recorded checksum — BEFORE their own version-tag gate and BEFORE the publish step.** Neither job
rebuilds the binary itself: they ship exactly what `build-platform` produced.

**Locally**, `bun run build:runtime --platform-package` (or `bun run scripts/build-runtime.ts
--platform-package`) stages `packages/platform/darwin-arm64/bin/winter` — git-ignored, built on
demand, never committed. `scripts/release-pack.ts` HARD-FAILS a pack attempted on a matching host
(`darwin`/`arm64`) with that file missing, naming the exact command to run first; on a non-matching
host (e.g. this repo's own `ubuntu-latest` `pack-smoke` jobs) the same absence is expected and
tolerated — a package manager on Linux was never going to fetch this binary either.

**The smoke (`scripts/smoke-installed.ts`) treats a bin-only package differently from an importable
one**: it executes `<bin> --version` and compares it to the package's own `version` when `os`/`cpu`
match the current host, and prints an explicit `SKIP … (bin-only; os/cpu mismatch on …)` line
otherwise — never a silent no-op, and never an import attempt that would fail for the wrong reason.

A Norma consumer (`packages/core`) resolves this package via `createRequire(...).resolve` and never
needs `dist/winter` built from an SDK checkout once it installs from a real release —
see that repo's `runtime-sdk/executable.ts` and P9a-8/P9a-9.

The npm set is **data** (`winter.publish.npm` per manifest), asserted to equal the transitive
workspace `dependencies` closure of the ROOTS: the wrapper, plus every package flagged
`winter.publish.harness` (R-7b-5 — the two conformance harnesses, which the out-of-repo router
package `@yanlinglabs/winter-runtime-sdk` needs as dev dependencies). `winter-provider-runtime` is on
npm by closure, not as a harness: `winter-provider-conformance` imports values from it, and a
published manifest pins its dependencies at an exact version, so a harness on npm whose dependency is
absent is an install that 404s.

Two flags, not one wider flag, because that is what keeps the rule falsifiable: `npm: true` on a
package that is neither a root nor reachable from one is still a refusal, and
`scripts/release-gates.test.ts` shows the rule refusing on synthetic trees rather than only agreeing
on this one. The npm job publishes in **topological order** (`npmPublishOrder`), so npm never serves
a package whose declared dependency is not there yet.

## Before pushing the tag

1. `bun run version:bump` (or `--minor`/`--major`), then `bun run version:sync`, and **commit**.
   `scripts/check-release-version.ts` refuses to publish when the tag, `VERSION` and every publishable
   manifest do not agree — a mismatch does not fail the publish, it *succeeds* at publishing the wrong
   number.
2. If the release is meant for npm too, make sure `NPM_TOKEN` exists **before** the tag is pushed.
   Without it the npm job is skipped, the workflow goes green, GitHub Packages has the version and npm
   has nothing — and adding the secret afterwards ships nothing until a re-drive. (GitHub Packages
   only, the current choice, needs no secret.)
3. Tag `v<version>` and push the tag. Nothing else publishes: the workflow fires only on a `v*` tag or
   a `workflow_dispatch`, and its publish jobs run only on a `v*` tag ref, so neither a `phase-*` tag
   nor a dispatch on a branch can publish.

## If a job fails

**Do not bump the version.** Both registries refuse a version they already hold, so a bump would leave
the tag naming something other than what shipped.

Re-drive instead: **`workflow_dispatch` at the same tag ref**.

The two jobs skip already-published versions by **different** mechanisms, and it matters which:

- **Job 2 (npm)** skips through our own seam, inside `scripts/publish-npm-set.ts`: it asks npm per
  package and prints the verdict. Deleting or failing that check changes what is published.
- **Job 1 (GitHub Packages)** skips through **pnpm's own** `isAlreadyPublished`.
  `scripts/check-already-published.ts` in that job only **reports** — it always exits 0, by design —
  so removing it would change the log and nothing else. pnpm's probe swallows every error as "not
  published", which errs toward *publishing*; the registry then refuses a genuine duplicate with a
  409. Safe, but it is not the audited seam, and an operator should not read the report step as the
  gate.

Either way the re-drive finishes the half that failed and reports the half that did not need doing.

A probe that cannot be answered — an auth failure, a network error — is treated as **not published**
and the publish is attempted: the registry refuses a genuine duplicate with a legible 409, whereas
reading an unanswerable probe as "already there" would silently ship four packages instead of five.

## The docs gates are heuristics

Two `release-gates` assertions read the shipped READMEs as prose: "no README may claim a path ships
that `files` excludes", and "no README names a non-npm package as being on npm". Both are regexes over
English, and a regex over English is a heuristic:

- a claim can be *negated in one clause and asserted in another* on the same line;
- a path can be written without backticks;
- a sentence can name a non-npm package near an npm claim in phrasing the pattern does not match.

Round 4 narrowed the negation skip to the matched clause and accepts unbackticked `src/`, which closes
the two evasions the review demonstrated. The class remains: these gates catch the mistakes people
actually make (a stale sentence surviving a rewrite) and cannot prove a README is true. **When you
change what ships, re-read the six package READMEs** — the gate is a net, not a proof.

## What ships

Compiled output only: `dist/` (bundled JS + `.d.ts`), each package's data files (`generated/`,
`overlay/`, `schema/`, `goldens/`), `README.md`, `LICENSE`, and `NOTICE` where third-party attribution
applies. No `src/` — the sources live in this repository.

`pnpm publish` packs byte-identically to `pnpm pack` (verified: same sha1 for the same tree), which is
what lets `releasePack()`'s scan and the installed-import smoke stand in for the artifact a registry
receives.

## Carries for the next release



- **Trusted Publishing.** Both npm packages now exist, so npm Trusted Publishing (OIDC from `release.yml`, configured per package on npmjs.com against this repository and workflow) can replace the long-lived `NPM_TOKEN` secret. Adopt it for the next release, then revoke the token.

- **Job 1's order is pnpm's, not topological.** `pnpm publish -r` may publish a dependent seconds before its dependency on GitHub Packages (the npm job publishes per tarball in dependency order). Accepted for the org's own registry; a per-package loop would fix it at the cost of pnpm's native `publishConfig` handling.
