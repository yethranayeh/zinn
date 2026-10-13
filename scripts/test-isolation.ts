/** Points ZINN_DIR at a temporary directory before any test module loads, so tests never reach ~/.zinn. */
import { setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);

const packagesDirectory = fileURLToPath(new URL("../packages", import.meta.url));
export const SOURCE_IDENTITY_MODULES = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    path: join(packagesDirectory, entry.name, "src", "release-identity.ts"),
  }))
  .filter((entry) => existsSync(entry.path));

for (const identity of SOURCE_IDENTITY_MODULES) {
  const { RELEASE_MODE } = await import(pathToFileURL(identity.path).href);

  if (RELEASE_MODE !== "source") {
    throw new Error(
      `Refusing to run tests with published source identity. Restore source in ${identity.path}.`,
    );
  }
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
