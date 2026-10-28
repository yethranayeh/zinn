import type { Ctx, DetailState, Loaded, Relation, TaskDetail, TaskSummary } from "./types.ts";

import { appendFileSync } from "node:fs";
import { createSignal } from "solid-js";

type BunProc = Bun.Subprocess<"ignore", "pipe", "pipe">;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
    }
  }
  return out;
}
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
export function log(_ctx: Ctx, message: string, extra?: Record<string, unknown>): void {
  const path = process.env.ZINN_INSPECTOR_LOG;
  if (!path) {
    return;
  }
  try {
    const line = `${new Date().toISOString()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`;
    appendFileSync(path, line);
  } catch {}
}
export function zinnErrorCode(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const body = isRecord(parsed) ? parsed["error"] : undefined;
    return isRecord(body) ? asString(body["code"]) : undefined;
  } catch {
    return undefined;
  }
}
export function zinnErrorMessage(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const body = parsed["error"];
      if (isRecord(body)) {
        const message = asString(body["message"]);
        if (message) {
          return message;
        }
      }
    }
  } catch {
    return trimmed.split("\n")[0];
  }
  return trimmed.split("\n")[0];
}
export async function runZinn(args: string[]): Promise<Loaded<string>> {
  const cmd = ["zinn", ...args];
  let proc: BunProc;

  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (error) {
    return { ok: false, error: `cannot run zinn: ${errorText(error)}` };
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: zinnErrorMessage(stderr) ?? `zinn exited with code ${exitCode}`,
        code: zinnErrorCode(stderr),
      };
    }
    return { ok: true, value: stdout };
  } catch (error) {
    return { ok: false, error: `zinn read failed: ${errorText(error)}` };
  }
}
export function parseTaskList(raw: string): Loaded<Map<string, TaskSummary>> {
  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `bad zinn json: ${errorText(error)}` };
  }

  if (!Array.isArray(data)) {
    return { ok: false, error: "unexpected zinn task list shape" };
  }

  const map = new Map<string, TaskSummary>();
  for (const item of data) {
    if (!isRecord(item)) {
      continue;
    }
    const key = asString(item["key"]);
    const title = asString(item["title"]);
    if (!key || !title) {
      continue;
    }
    map.set(key, {
      key,
      title,
      status: asString(item["status"]) ?? "",
      column: asString(item["column"]) ?? "",
      priority: asString(item["priority"]) ?? null,
      labels: asStringArray(item["labels"]),
    });
  }
  return { ok: true, value: map };
}
export const LABEL_HEX = {
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  gray: "#666666",
};
export type LabelColor = string | null;
export type LabelColors = ReadonlyMap<string, LabelColor>;
export const PRIORITY_COLOR: Record<string, string> = {
  urgent: LABEL_HEX["red"],
  high: LABEL_HEX["yellow"],
  medium: LABEL_HEX["blue"],
  low: LABEL_HEX["gray"],
};
export const CHIP_PRIORITY = "urgent";
export const CHIP_PAD = 2;
export const CONTEXT_SEPARATOR = " | ";
export const LABEL_SEPARATOR = ", ";
export const [labelColors, setLabelColors] = createSignal<LabelColors>(new Map());
export function parseLabelColors(raw: string): LabelColors {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!Array.isArray(data)) {
    return new Map();
  }
  const out = new Map<string, LabelColor>();
  for (const item of data) {
    if (!isRecord(item)) {
      continue;
    }
    const name = asString(item["name"]);
    if (!name) {
      continue;
    }
    out.set(
      name,
      (LABEL_HEX as Record<string, string | undefined>)[asString(item["color"]) ?? ""] ?? null,
    );
  }
  return out;
}
export function parseRelations(value: unknown): Relation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Relation[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const task = item["task"];
    if (!isRecord(task)) {
      continue;
    }
    const key = asString(task["key"]);
    if (!key) {
      continue;
    }
    out.push({
      type: asString(item["type"]) ?? "related",
      direction: asString(item["direction"]) ?? "outgoing",
      task: {
        key,
        title: asString(task["title"]) ?? "",
        status: asString(task["status"]) ?? "",
      },
    });
  }
  return out;
}
export function parseTaskDetail(raw: string): Loaded<TaskDetail> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `bad zinn json: ${errorText(error)}` };
  }

  if (!isRecord(data)) {
    return { ok: false, error: "unexpected zinn task view shape" };
  }

  const key = asString(data["key"]);
  const title = asString(data["title"]);
  if (!key || !title) {
    return { ok: false, error: "zinn task view had no key/title" };
  }

  const comments = Array.isArray(data["comments"]) ? data["comments"].length : 0;
  return {
    ok: true,
    value: {
      key,
      title,
      status: asString(data["status"]) ?? "",
      column: asString(data["column"]) ?? "",
      priority: asString(data["priority"]) ?? null,
      labels: asStringArray(data["labels"]),
      relations: parseRelations(data["relations"]),
      comments,
      description: asString(data["description"]) ?? "",
    },
  };
}
export let keyMapCache: Promise<Loaded<Map<string, TaskSummary>>> | undefined;
export let keyMapInflight: Promise<Loaded<Map<string, TaskSummary>>> | undefined;
export function loadKeyMap(): Promise<Loaded<Map<string, TaskSummary>>> {
  if (!keyMapCache) {
    void loadLabelColors();
    const pending = runZinn(["task", "list", "--json"]).then((result) => {
      if (!result.ok) {
        return result;
      }
      return parseTaskList(result.value);
    });
    keyMapCache = pending;
    keyMapInflight = pending;
    void pending.then(() => {
      if (keyMapInflight === pending) {
        keyMapInflight = undefined;
      }
    });
  }
  return keyMapCache;
}
export const LABEL_TTL_MS = 5 * 60 * 1000;
export let labelColorsCache: Promise<void> | undefined;
export let labelColorsAt = 0;
export let labelColorsInflight = false;
export function loadLabelColors(force = false): Promise<void> {
  if (labelColorsInflight && labelColorsCache !== undefined) {
    return labelColorsCache;
  }
  if (
    !force &&
    labelColorsCache !== undefined &&
    labelColorsAt !== 0 &&
    Date.now() - labelColorsAt <= LABEL_TTL_MS
  ) {
    return labelColorsCache;
  }
  labelColorsInflight = true;
  const pending = runZinn(["label", "list", "--json"])
    .then((result) => {
      if (result.ok) {
        setLabelColors(parseLabelColors(result.value));
        labelColorsAt = Date.now();
      }
    })
    .finally(() => {
      labelColorsInflight = false;
    });
  labelColorsCache = pending;
  return pending;
}
export function refreshKeyMap(forceLabels = false): Promise<Loaded<Map<string, TaskSummary>>> {
  void loadLabelColors(forceLabels);
  if (keyMapInflight) {
    keyMapCache = keyMapInflight;
    return keyMapInflight;
  }
  keyMapCache = undefined;
  return loadKeyMap();
}
export const BOARD_TTL_MS = 60 * 1000;
export function shouldReadBoard(input: {
  force: boolean;
  zinnTotal: number;
  lastReadZinn: number;
  msSinceRead: number;
  ttl: number;
}): boolean {
  if (input.force) {
    return true;
  }
  if (input.zinnTotal !== input.lastReadZinn) {
    return true;
  }
  return input.msSinceRead > input.ttl;
}
export const flaggedUnknown = new Map<string, Set<string>>();
export function flaggedFor(sessionID: string): Set<string> {
  let set = flaggedUnknown.get(sessionID);
  if (!set) {
    set = new Set<string>();
    flaggedUnknown.set(sessionID, set);
  }
  return set;
}
export function loadDetail(key: string): Promise<DetailState> {
  return runZinn(["task", "view", key, "--json"]).then((result) => {
    if (!result.ok) {
      return { kind: "error", error: result.error };
    }
    const parsed = parseTaskDetail(result.value);
    if (!parsed.ok) {
      return { kind: "error", error: parsed.error };
    }
    return { kind: "ready", detail: parsed.value };
  });
}
