// Test preload: NO TEST MAY EVER WRITE UNDER THE REAL WINTER HOME.
//
// Every package's `bunfig.toml` preloads this beside the Keychain and network guards. When the run has no
// winter home variable of its own, it points one at a fresh temp directory, so anything that resolves the winter
// home by default -- `resolveWinterHome()`, production wiring's store and winter homes, and through them
// the image working directory (`<store|winter home>/image-prep`, runtime tools/image-prep.ts) -- lands in
// a throwaway folder, in this process and in every child it spawns (children inherit the environment). A
// test that needs the unset case deletes the variable itself, as the path tests already do.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Relative, not the package: `brand.ts` needs only `errors.ts`, so this preload loads little before a test.
import { WINTER_BRAND, envName, installBrand } from "../packages/sdk/src/brand.ts";

/** Set by this preload when it supplied the temp home, so a test can tell the two apart. */
export const TEST_WINTER_HOME_MARKER = "WINTER_TEST_HOME_FROM_PRELOAD";

// The home variable of the brand the test suites run under -- Winter's own: this repository's tests are
// Winter's, and a reuser's product has its own test setup.
const HOME_VAR = envName(WINTER_BRAND, "HOME");

if (process.env[HOME_VAR] === undefined || process.env[HOME_VAR] === "") {
  process.env[HOME_VAR] = mkdtempSync(join(tmpdir(), "winter-test-home-"));
  process.env[TEST_WINTER_HOME_MARKER] = "1";
}

// A1 (fail closed): the SDK has no default brand any more; a reader handed none reads the brand
// INSTALLED for its process and otherwise throws `BrandRequiredError`. This repository's suites are
// Winter's own, so the test process installs Winter's profile (with the temp home above): every
// hand-built config and unbranded call in a test keeps exactly the names it had. A child process a
// test spawns does NOT inherit this: it installs the brand its own config names, or is refused, which
// is the production behaviour the fail-closed tests exercise.
installBrand(WINTER_BRAND);
