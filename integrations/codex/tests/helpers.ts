import type { Settings } from "../src/settings";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../../../packages/core/src/sqlite/bun.ts";
import { seedBaseline, snapshot } from "../../../packages/core/src/migrations/testing.ts";

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
  const home = join(directory, "home");

  mkdirSync(settings.store);
  mkdirSync(home);
  writeFileSync(config, JSON.stringify(settings));

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZINN_CODEX_CONFIG: config,
    ZINN_DIR: settings.store,
  };
  function cli(args: string[], store = settings.store) {
    const boundary = args.indexOf("--");
    const commandArgs =
      boundary < 0
        ? [...args, "--json"]
        : [...args.slice(0, boundary), "--json", ...args.slice(boundary)];
    const result = Bun.spawnSync([...settings.cli, ...commandArgs], {
      env: { ...env, ZINN_DIR: store },
    });
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

export function seedOlderStore(store: string) {
  mkdirSync(join(store, "data"), { recursive: true });
  const db = openDatabase(join(store, "data/zinn.sqlite"));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    seedBaseline(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

export function inspectStore(store: string) {
  const db = openDatabase(join(store, "data/zinn.sqlite"), { create: false });
  try {
    db.exec("PRAGMA query_only = ON");
    return {
      snapshot: snapshot(db),
      integrity: db.query("PRAGMA integrity_check").all(),
      foreignKeys: db.query("PRAGMA foreign_key_check").all(),
    };
  } finally {
    db.close();
  }
}

export async function waitFor(check: () => boolean) {
  const began = performance.now();
  const waitBudgetMs = 3000;
  const pollMs = 10;
  while (!check()) {
    if (performance.now() - began >= waitBudgetMs) {
      throw new Error("Fixture did not reach its expected state.");
    }
    await Bun.sleep(pollMs);
  }
}
