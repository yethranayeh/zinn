import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDatabaseForTests } from "./db";

/** Selects a store for a synchronous case and restores process state afterwards. */
export function withStore<T>(directory: string, check: () => T): T {
  return withEnvironment({ ZINN_DIR: directory }, check);
}

/** A fresh store for one synchronous case, closed before its files are removed. */
export function withTestStore<T>(check: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "zinn-core-"));
  try {
    return withStore(directory, () => check(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Restores the selected environment and working directory even when a case throws. */
export function withEnvironment<T>(
  environment: Record<string, string | undefined>,
  check: () => T,
  cwd = process.cwd(),
): T {
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const previousCwd = process.cwd();
  resetDatabaseForTests();
  const home = environment.HOME;
  const homeSpy = home === undefined ? null : spyOn(os, "homedir").mockReturnValue(home);
  try {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.chdir(cwd);
    return check();
  } finally {
    resetDatabaseForTests();
    homeSpy?.mockRestore();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
