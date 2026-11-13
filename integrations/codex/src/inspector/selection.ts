import type { Settings } from "../settings";
import type { CliReader } from "../shared/cli";
import type { TaskRead } from "./task-reader";

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { argvKeys } from "../shared/keys";
import { resolveChat } from "./references";
import { readTask } from "./task-reader";

type SelectionSettings = Pick<Settings, "store" | "dataDirectory">;
export type SelectionContext = { scope: string | null; warning?: string };
export type InspectorRead = TaskRead & { selection: SelectionContext };
export type SelectionSave = { saved: boolean; warning?: string };

// A selection record contains only a format version and one task key.
const MAX_SELECTION_BYTES = 1024;

function selectionContext(
  settings: SelectionSettings,
  metadata?: Record<string, unknown>,
): SelectionContext {
  const binding = resolveChat(metadata);
  if (binding.session === undefined) {
    return {
      scope: null,
      warning:
        binding.kind === "conflicting_metadata"
          ? "Selection cannot be remembered while the host supplies conflicting chat IDs."
          : "Selection cannot be remembered without a host chat ID.",
    };
  }

  return {
    scope: createHash("sha256")
      .update(JSON.stringify([binding.session, settings.store]))
      .digest("hex"),
  };
}

function selectionPath(settings: SelectionSettings, scope: string) {
  return join(settings.dataDirectory, "selections", `v1-${scope}.json`);
}

function readSelection(
  settings: SelectionSettings,
  context: SelectionContext,
): SelectionContext & { key?: string } {
  if (context.scope === null) {
    return context;
  }
  try {
    const descriptor = openSync(selectionPath(settings, context.scope), "r");
    let value;

    try {
      if (fstatSync(descriptor).size > MAX_SELECTION_BYTES) {
        throw new Error("Selection record exceeds its limit.");
      }
      value = JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }

    const validRecord =
      value !== null &&
      typeof value === "object" &&
      Object.keys(value).length === 2 &&
      value.version === 1 &&
      typeof value.key === "string" &&
      argvKeys([value.key])[0] === value.key;

    if (!validRecord) {
      throw new Error("Invalid selection record.");
    }

    return { ...context, key: value.key };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return context;
    }
    return {
      ...context,
      warning: "The previous selection could not be restored. Manual lookup is available.",
    };
  }
}

export async function readInspectorTask(
  settings: Settings,
  rawKey: string | undefined,
  reader: CliReader,
  metadata?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<InspectorRead> {
  const context = selectionContext(settings, metadata);
  const restored: SelectionContext & { key?: string } =
    rawKey === undefined ? readSelection(settings, context) : context;
  const key = rawKey ?? restored.key;
  const result = await readTask(settings, key, reader, signal);
  return { ...result, selection: { scope: restored.scope, warning: restored.warning } };
}

export function rememberSelection(
  settings: SelectionSettings,
  rawKey: string,
  expectedScope: string,
  metadata?: Record<string, unknown>,
): SelectionSave {
  const context = selectionContext(settings, metadata);
  if (context.scope === null || context.scope !== expectedScope) {
    return {
      saved: false,
      warning: "Selection was not remembered because the chat or store context changed.",
    };
  }
  const key = rawKey.trim().toUpperCase();
  const bytes = Buffer.from(JSON.stringify({ version: 1, key }) + "\n");
  if (argvKeys([key])[0] !== key || bytes.length > MAX_SELECTION_BYTES) {
    return {
      saved: false,
      warning: "Selection was not remembered because the task key is invalid.",
    };
  }

  const directory = join(settings.dataDirectory, "selections");
  const temporary = join(directory, `.selection-${randomUUID()}.tmp`);
  let created = false;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const descriptor = openSync(temporary, "wx", 0o600);
    created = true;

    try {
      writeFileSync(descriptor, bytes);
    } finally {
      closeSync(descriptor);
    }

    // Readers see a complete record even when another panel saves concurrently.
    renameSync(temporary, selectionPath(settings, context.scope));
    created = false;
    return { saved: true };
  } catch {
    return {
      saved: false,
      warning: "Selection could not be remembered. Task inspection is still available.",
    };
  } finally {
    if (created) {
      try {
        unlinkSync(temporary);
      } catch {
        // Incomplete temporary files are never read as saved selections.
      }
    }
  }
}
