import type { Settings } from "../src/settings";

import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../../../packages/core/src/sqlite/bun.ts";
import { seedBaseline, snapshot } from "../../../packages/core/src/migrations/testing.ts";

export const repository = resolve(import.meta.dir, "../../..");
export const cliPath = join(repository, "packages/cli/dist/index.js");

type CliTrace = {
  file: string;
  args: Array<string>;
  startedMs: number;
  finishedMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  kills: Array<{ signal: string; atMs: number }>;
};

export function traceHook(
  hook: string,
  env: NodeJS.ProcessEnv,
  payload: unknown,
  tracePath: string,
) {
  const preload = pathToFileURL(join(import.meta.dir, "trace-cli.mjs")).href;
  const result = Bun.spawnSync(["node", "--import", preload, hook], {
    env: { ...env, ZINN_CODEX_TEST_TRACE: tracePath },
    stdin: Buffer.from(JSON.stringify(payload)),
  });
  const calls: Array<CliTrace> = existsSync(tracePath)
    ? JSON.parse(readFileSync(tracePath, "utf8"))
    : [];
  const diagnostics = JSON.stringify({ hookExitCode: result.exitCode, calls }, null, 2);

  return { result, calls, diagnostics };
}

export function actorEnvironmentNames() {
  const source = readFileSync(join(repository, "packages/cli/src/actor.ts"), "utf8");
  const markerBlock = source.match(/const AGENT_MARKERS[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
  const sessionBlock = source.match(/const SESSION_DECLARATIONS = \[([\s\S]*?)\] as const;/)?.[1];
  const identityBlock = source.match(/function readExecutionIdentity[\s\S]*?\n\}/)?.[0];

  expect(markerBlock).toBeDefined();
  expect(sessionBlock).toBeDefined();
  expect(identityBlock).toBeDefined();

  const markers = [...markerBlock!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1]!);
  const declarations = [...sessionBlock!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map(
    (match) => match[1]!,
  );
  const identity = [...identityBlock!.matchAll(/readDeclaration\(env, "([A-Z][A-Z0-9_]*)"\)/g)].map(
    (match) => match[1]!,
  );

  return [...new Set([...markers, ...declarations, ...identity])].sort();
}

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

  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const name of actorEnvironmentNames()) {
    delete inherited[name];
  }

  const env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    ZINN_CODEX_CONFIG: config,
    ZINN_DIR: settings.store,
  };

  function cli(args: Array<string>, store = settings.store) {
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
