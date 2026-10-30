import type { Settings } from "../src/settings";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const repository = resolve(import.meta.dir, "../../..");
export const cliPath = join(repository, "packages/cli/dist/index.js");
export function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zinn-codex-")));
  const settings: Settings = {
    store: join(directory, "store"),
    dataDirectory: join(directory, "references"),
    cli: ["node", cliPath],
    observe: true,
    identity: true,
    captureEffort: false,
  };
  const config = join(directory, "codex.json");

  mkdirSync(settings.store);
  writeFileSync(config, JSON.stringify(settings));

  const env = { ...process.env, ZINN_CODEX_CONFIG: config, ZINN_DIR: settings.store };
  function cli(args: string[]) {
    const result = Bun.spawnSync([...settings.cli, ...args, "--json"], { env });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }

    return JSON.parse(result.stdout.toString());
  }

  return {
    directory,
    settings,
    config,
    env,
    cli,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
