import type { Ctx, Mention, Scan, TaskSummary } from "./types.ts";
import { asString, isRecord, log } from "./data.ts";

const KEY_SHAPE = /\b[A-Z][A-Z0-9]{0,9}-\d{1,6}\b/g;

export function prefixOf(key: string): string {
  const dash = key.indexOf("-");
  return dash === -1 ? key : key.slice(0, dash);
}
export const SCAN_LOG_EVERY = 50;
export let scanCount = 0;
export const ZINN_INVOCATION =
  /(?:^|[\s;&|("'`])(?:[^\s;&|("'`]*\/)?zinn(?:\.exe)?(?=$|[\s;&|)"'`])/;
export type CachedMessage = {
  tokens: string[];
  textParts: number;
  streamingParts: number;
  plan: Array<{
    content?: unknown;
  }> | null;
  zinnCommands: number;
};
export type ScanCache = {
  byID: Map<string, CachedMessage>;
  computes: number;
};
export type ScanMessage = {
  readonly id?: unknown;
  readonly type: string;
  readonly text?: unknown;
  readonly time?: {
    readonly completed?: unknown;
  };
  readonly content?: ReadonlyArray<unknown>;
};
export function isCacheableMessage(message: ScanMessage): boolean {
  if (message.type === "user") {
    return true;
  }
  return message.type === "assistant" && message.time?.completed !== undefined;
}
export function extractMessage(message: ScanMessage): CachedMessage {
  const tokens: string[] = [];
  let textParts = 0;
  let streamingParts = 0;
  let plan: Array<{
    content?: unknown;
  }> | null = null;
  let zinnCommands = 0;

  const take = (text: unknown) => {
    if (typeof text !== "string") {
      return;
    }
    KEY_SHAPE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = KEY_SHAPE.exec(text)) !== null) {
      tokens.push(match[0]);
    }
  };

  if (message.type === "user") {
    textParts += 1;
    take(message.text);
    return { tokens, textParts, streamingParts, plan, zinnCommands };
  }

  if (message.type !== "assistant") {
    return { tokens, textParts, streamingParts, plan, zinnCommands };
  }

  const streaming = message.time?.completed === undefined;
  for (const raw of message.content ?? []) {
    if (!isRecord(raw)) {
      continue;
    }

    if (raw["type"] === "text") {
      textParts += 1;
      if (streaming) {
        streamingParts += 1;
        continue;
      }
      take(raw["text"]);
      continue;
    }

    if (raw["type"] !== "tool") {
      continue;
    }
    const state = isRecord(raw["state"]) ? raw["state"] : undefined;
    const input = isRecord(state?.["input"]) ? state["input"] : undefined;
    const command = input?.["command"];

    if (typeof command === "string" && ZINN_INVOCATION.test(command)) {
      zinnCommands += 1;
    }

    const toolName = raw["name"] ?? raw["tool"];
    if (
      toolName === "todowrite" &&
      state?.["status"] === "completed" &&
      Array.isArray(input?.["todos"])
    ) {
      plan = input!["todos"] as Array<{
        content?: unknown;
      }>;
    }
  }
  return { tokens, textParts, streamingParts, plan, zinnCommands };
}
export function scanSession(
  ctx: Ctx,
  sessionID: string,
  map: Map<string, TaskSummary>,
  cache?: ScanCache,
): Scan {
  const started = Date.now();
  const order: string[] = [];
  const counts = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  const prefixes = new Set<string>();
  let textParts = 0;
  let streamingParts = 0;
  let zinnCommands = 0;
  let seq = 0;
  let plan: Array<{
    content?: unknown;
  }> = [];

  for (const existing of map.keys()) {
    prefixes.add(prefixOf(existing));
  }

  const collect = (text: string) => {
    KEY_SHAPE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = KEY_SHAPE.exec(text)) !== null) {
      const token = match[0];
      if (!counts.has(token)) {
        order.push(token);
      }
      counts.set(token, (counts.get(token) ?? 0) + 1);
      lastSeen.set(token, seq++);
    }
  };
  const messages = ctx.data.session.message.list(sessionID);
  scanCount += 1;
  const sampled = scanCount === 1 || scanCount % SCAN_LOG_EVERY === 0;
  const facts: CachedMessage[] = [];
  const ids: string[] = [];
  let computes = 0;

  for (const message of messages) {
    const view = message as unknown as ScanMessage;
    const id = asString(view.id);
    if (id !== undefined) {
      ids.push(id);
    }

    const hit = id !== undefined && cache !== undefined ? cache.byID.get(id) : undefined;
    if (hit !== undefined) {
      facts.push(hit);
      continue;
    }

    const extracted = extractMessage(view);
    computes += 1;
    if (id !== undefined && cache !== undefined && isCacheableMessage(view)) {
      cache.byID.set(id, extracted);
    }
    facts.push(extracted);
  }

  for (const factsOfMessage of facts) {
    for (const token of factsOfMessage.tokens) {
      if (!counts.has(token)) {
        order.push(token);
      }
      counts.set(token, (counts.get(token) ?? 0) + 1);
      lastSeen.set(token, seq++);
    }
    textParts += factsOfMessage.textParts;
    streamingParts += factsOfMessage.streamingParts;
    zinnCommands += factsOfMessage.zinnCommands;
    if (factsOfMessage.plan !== null) {
      plan = factsOfMessage.plan;
    }
  }

  if (cache !== undefined) {
    const live = new Set(ids);
    for (const key of [...cache.byID.keys()]) {
      if (!live.has(key)) {
        cache.byID.delete(key);
      }
    }
    cache.computes += computes;
  }

  if (sampled) {
    log(ctx, "scan input", {
      session: sessionID,
      messages: messages.length,
      computed: computes,
      cached: messages.length - computes,
      scan: scanCount,
    });
  }

  let planKeys = 0;
  for (const item of plan) {
    const content = item?.content;
    if (typeof content !== "string") {
      continue;
    }
    const before = order.length;
    collect(content);
    planKeys += order.length - before;
  }

  if (sampled) {
    log(ctx, "scan plan", {
      session: sessionID,
      items: plan.length,
      keys: planKeys,
      scan: scanCount,
    });
  }

  const byRecency = (keys: string[]): string[] =>
    [...keys].sort((a, b) => (lastSeen.get(b) ?? 0) - (lastSeen.get(a) ?? 0));
  const known: Mention[] = [];
  const unknown: Mention[] = [];
  for (const key of byRecency(order)) {
    const mention = { key, count: counts.get(key) ?? 1 };
    if (map.has(key)) {
      known.push(mention);
    } else if (prefixes.has(prefixOf(key))) {
      unknown.push(mention);
    }
  }

  return {
    known,
    unknown,
    tokens: order.length,
    textParts,
    streamingParts,
    zinnCommands,
    ms: Date.now() - started,
  };
}

export function newestIdleID(
  messages: ReadonlyArray<{
    id: string;
    type: string;
  }>,
): string | undefined {
  const last = messages[messages.length - 1];
  return last !== undefined && last.type === "idle" ? last.id : undefined;
}

export function mentionCounts(mentions: readonly Mention[]): ReadonlyMap<string, number> {
  return new Map(mentions.map((mention) => [mention.key, mention.count]));
}
