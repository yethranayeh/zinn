/** Points ZINN_DIR at a temporary directory before any test module loads, so tests never reach ~/.zinn. */
import { setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_STAMP_FILE } from "../packages/core/src/release.ts";

const DEFAULT_TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);

const PACKAGES_DIRECTORY = fileURLToPath(new URL("../packages", import.meta.url));
const leftoverStamps = readdirSync(PACKAGES_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(PACKAGES_DIRECTORY, entry.name, RELEASE_STAMP_FILE))
  .filter((stampPath) => existsSync(stampPath));

if (leftoverStamps.length > 0) {
  throw new Error(
    `Refusing to run tests with release stamps in the source checkout:\n${leftoverStamps.join("\n")}\n` +
      "Run `bun ../../scripts/release-stamp.ts remove` from each listed package directory, then rerun bun test.",
  );
}

const PREFIX = join(tmpdir(), "zinn-test-run-");
/** This run's directory, shared by every test that loads core in the test process. */
export const TEST_RUN_DIR = mkdtempSync(PREFIX);

process.env.ZINN_DIR = TEST_RUN_DIR;

process.on("exit", () => {
  if (!TEST_RUN_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_RUN_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_RUN_DIR, { recursive: true, force: true });
});
