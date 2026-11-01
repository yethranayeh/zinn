/** Points ZINN_DIR at a temporary directory before any test module loads, so tests never reach ~/.zinn. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/test.ts sets the timeout and concurrency limit that keep CLI subprocess tests reliable.
// Bun reads neither from bunfig.toml, so a run without the script would use Bun's defaults.
if (process.env.ZINN_TEST_RUNNER !== "1") {
  throw new Error(
    "Run the tests with `bun run test`, optionally followed by test file paths and `-t <name>`. " +
      "It sets the timeout and concurrency limit and keeps each run's results in .test-results/.",
  );
}

// Conflicting inherited color flags make node:assert emit warnings in test subprocesses.
delete process.env.NO_COLOR;
delete process.env.FORCE_COLOR;
// Tests that run core in this process expect hooks to be eneabled
delete process.env.ZINN_HOOKS;

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

const home = join(TEST_RUN_DIR, "home");
mkdirSync(home);

/** CLI subprocesses inherit only tool paths; each case supplies its own application variables. */
export const TEST_ENVIRONMENT: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  TMPDIR: tmpdir(),
  HOME: home,
  TZ: "UTC",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  GIT_CONFIG_NOSYSTEM: "1",
};

process.env.ZINN_DIR = TEST_RUN_DIR;

process.on("exit", () => {
  if (!TEST_RUN_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_RUN_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_RUN_DIR, { recursive: true, force: true });
});
