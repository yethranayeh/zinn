/** Points ZINN_DIR at a temporary directory before any test module loads, so tests never reach ~/.zinn. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = join(tmpdir(), "zinn-test-run-");
const TEST_RUN_DIR = mkdtempSync(PREFIX);

process.env.ZINN_DIR = TEST_RUN_DIR;

process.on("exit", () => {
  if (!TEST_RUN_DIR.startsWith(PREFIX)) {
    throw new Error(`Refusing to delete "${TEST_RUN_DIR}": not a ${PREFIX}* directory`);
  }

  rmSync(TEST_RUN_DIR, { recursive: true, force: true });
});
