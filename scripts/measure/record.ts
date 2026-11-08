/** Creates one result folder per run and writes its meta.json. */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatSessionId } from "./quiet-session/format.ts";

/** The folder name for a run, stamped in local time. */
export function recordFolderPath(root: string, label: string, startedAt: Date): string {
  return path.join(root, `${formatSessionId(startedAt)}-${label}`);
}

/** Creates the folder for one run and refuses to reuse a name that already exists. */
export async function createRecordFolder(
  root: string,
  label: string,
  startedAt: Date,
): Promise<string> {
  const directory = recordFolderPath(root, label, startedAt);
  if (existsSync(directory)) {
    throw new Error(`Results folder already exists: ${directory}`);
  }
  await mkdir(root, { recursive: true });
  // Non-recursive on purpose, so a race fails instead of writing into the other run.
  await mkdir(directory);
  return directory;
}

export async function writeMeta(directory: string, meta: unknown): Promise<void> {
  await writeFile(path.join(directory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}
