import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type Settings = {
  store: string;
  dataDirectory: string;
  cli: Array<string>;
  observe: boolean;
  identity: boolean;
  captureEffort: boolean;
};

function canonicalPath(path: string): string {
  if (existsSync(path)) {
    return realpathSync(path);
  }

  return join(canonicalPath(dirname(path)), basename(path));
}

export function loadSettings(env = process.env, home = homedir()): Settings {
  const configPath = env.ZINN_CODEX_CONFIG ?? join(home, ".config/zinn/codex.json");
  if (!isAbsolute(configPath)) {
    throw new Error("ZINN_CODEX_CONFIG must be an absolute path.");
  }

  const value = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof value.store !== "string" || !isAbsolute(value.store)) {
    throw new Error("Set store to an absolute Zinn data directory in codex.json.");
  }

  const dataDirectory = value.dataDirectory ?? join(home, ".local/share/zinn-codex");
  if (typeof dataDirectory !== "string" || !isAbsolute(dataDirectory)) {
    throw new Error("dataDirectory must be an absolute path.");
  }

  const store = canonicalPath(resolve(value.store));
  const data = canonicalPath(resolve(dataDirectory));
  if (data === store || data.startsWith(store + sep)) {
    throw new Error("dataDirectory must be outside the selected Zinn data directory.");
  }

  const cli = value.cli ?? ["zinn"];
  if (
    !Array.isArray(cli) ||
    cli.length === 0 ||
    cli.some((word) => typeof word !== "string" || word === "")
  ) {
    throw new Error("cli must be a nonempty array of executable and argument strings.");
  }

  for (const option of ["observe", "identity", "captureEffort"]) {
    if (value[option] !== undefined && typeof value[option] !== "boolean") {
      throw new Error(`${option} must be a boolean.`);
    }
  }

  return {
    store,
    dataDirectory: data,
    cli,
    observe: value.observe ?? true,
    identity: value.identity ?? true,
    captureEffort: value.captureEffort ?? false,
  };
}
