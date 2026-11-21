import type {
  Ctx,
  DetailState,
  Loaded,
  Relation,
  TaskClaim,
  TaskDetail,
  TaskSummary,
} from "./types.ts";

import { appendFileSync } from "node:fs";
import { createSignal } from "solid-js";
import packageJson from "../package.json" with { type: "json" };

type BunProc = Bun.Subprocess<"ignore", "pipe", "pipe">;
/** Child environment overrides. A null removes the variable from the child. */
export type ChildEnvironment = Record<string, string | null>;

const INSPECTOR_CLIENT = `zinn-opencode:inspector/${packageJson.version}`;

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
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
export function zinnErrorReason(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const body = isRecord(parsed) ? parsed["error"] : undefined;
    const details = isRecord(body) ? body["details"] : undefined;
    return isRecord(details) ? asString(details["reason"]) : undefined;
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
export const CLI_READ_TIMEOUT_MS = 15_000;
/**
 * The child's environment: the inherited one, the overrides on top, and null removing a variable.
 * ZINN_CLIENT is set by `runZinn`, so an inherited value cannot win.
 */
export function buildChildEnvironment(
  inherited: Record<string, string | undefined>,
  overrides: ChildEnvironment,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      child[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      delete child[name];
      continue;
    }
    child[name] = value;
  }
  return child;
}
export async function runZinn(
  args: string[],
  timeoutMs = CLI_READ_TIMEOUT_MS,
  environment: ChildEnvironment = {},
): Promise<Loaded<string>> {
  const cmd = ["zinn", ...args];
  const inheritedClient = process.env["ZINN_CLIENT"]?.trim() ?? "";
  const client =
    inheritedClient.length === 0 ? INSPECTOR_CLIENT : `${inheritedClient} ${INSPECTOR_CLIENT}`;
  const env = buildChildEnvironment(process.env, { ...environment, ZINN_CLIENT: client });
  let proc: BunProc;

  try {
    proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
    });
  } catch (error) {
    return { ok: false, error: `cannot run zinn: ${errorText(error)}` };
  }

  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) {
      return;
    }
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    settled = true;
    if (timedOut) {
      return { ok: false, error: `zinn read timed out after ${timeoutMs} ms` };
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        error: zinnErrorMessage(stderr) ?? `zinn exited with code ${exitCode}`,
        code: zinnErrorCode(stderr),
        reason: zinnErrorReason(stderr),
      };
    }
    return { ok: true, value: stdout };
  } catch (error) {
    settled = true;
    if (timedOut) {
      return { ok: false, error: `zinn read timed out after ${timeoutMs} ms` };
    }
    return { ok: false, error: `zinn read failed: ${errorText(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
export function parseClaim(value: unknown): TaskClaim | null {
  if (!isRecord(value)) {
    return null;
  }

  const state = asString(value["state"]);
  if (state !== "live" && state !== "expired") {
    return null;
  }

  return {
    state,
    sessionId: asString(value["actor_session_id"]) ?? null,
    threadId: asString(value["actor_thread_id"]) ?? null,
    renewedAt: asFiniteNumber(value["renewed_at"]),
    leaseMs: asFiniteNumber(value["lease_ms"]),
    expiresAt: asFiniteNumber(value["expires_at"]),
  };
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
      columnCategory: asString(item["column_category"]) ?? null,
      priority: asString(item["priority"]) ?? null,
      labels: asStringArray(item["labels"]),
      claim: parseClaim(item["claim"]),
    });
  }
  return { ok: true, value: map };
}
export function activeTaskMap(tasks: ReadonlyMap<string, TaskSummary>): Map<string, TaskSummary> {
  return new Map([...tasks].filter(([, task]) => task.status === "Active"));
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
    const pending = runZinn(["task", "list", "--all", "--json"]).then((result) => {
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
