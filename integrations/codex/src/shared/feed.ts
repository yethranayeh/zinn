import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MAX_EVENTS = 1024;
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_RECENT_KEYS = 24;

export type Reference = {
  key: string;
  source: "argv" | "dispatch" | "completed-reply";
  store: string;
};
export type Observation = {
  version: 1;
  session: string;
  ts: string;
  references: Array<Reference>;
  replyFailedStore: string | null;
};

export const sessionDirectory = (directory: string, session: string) =>
  join(directory, createHash("sha256").update(session).digest("hex"));

export function persist(directory: string, observation: Observation): boolean {
  const bytes = Buffer.from(JSON.stringify(observation) + "\n");
  if (bytes.byteLength > MAX_EVENT_BYTES) {
    return false;
  }

  const session = sessionDirectory(directory, observation.session);
  mkdirSync(session, { recursive: true, mode: 0o700 });

  for (let index = 0; index < MAX_EVENTS; index++) {
    let descriptor: number;
    try {
      descriptor = openSync(
        join(session, `${index.toString().padStart(4, "0")}.json`),
        "wx",
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }

    try {
      writeFileSync(descriptor, bytes);
    } finally {
      closeSync(descriptor);
    }

    return true;
  }

  return false;
}

export function readFeed(directory: string, session: string, store: string) {
  const observations: Observation[] = [];
  let incomplete = 0;
  let files: string[];
  const target = sessionDirectory(directory, session);

  try {
    files = readdirSync(target)
      .filter((file) => /^\d{4}\.json$/.test(file))
      .sort()
      .slice(0, MAX_EVENTS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, references: [], incomplete: 0, atCapacity: false, replyFailures: 0 };
    }
    throw error;
  }

  for (const file of files) {
    try {
      const path = join(target, file);
      if (statSync(path).size > MAX_EVENT_BYTES) {
        throw new Error("Oversized observation.");
      }

      const value = JSON.parse(readFileSync(path, "utf8"));
      const validReferences =
        Array.isArray(value.references) &&
        value.references.every(
          (item: Reference) =>
            item &&
            typeof item.key === "string" &&
            typeof item.store === "string" &&
            ["argv", "dispatch", "completed-reply"].includes(item.source),
        );

      if (
        value.version !== 1 ||
        value.session !== session ||
        typeof value.ts !== "string" ||
        !validReferences
      ) {
        throw new Error("Invalid observation.");
      }

      observations.push(value);
    } catch {
      incomplete++;
    }
  }

  observations.sort((left, right) => left.ts.localeCompare(right.ts));
  const references: Array<Reference> = [];
  const seen = new Set<string>();
  for (const observation of observations.reverse()) {
    for (const reference of observation.references) {
      if (reference.store === store && !seen.has(reference.key)) {
        seen.add(reference.key);
        references.push(reference);
      }
    }
  }

  return {
    present: true,
    references: references.slice(0, MAX_RECENT_KEYS),
    incomplete,
    atCapacity: files.length >= MAX_EVENTS,
    replyFailures: observations.filter((value) => value.replyFailedStore === store).length,
  };
}
