import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliReader, CliResult } from "../src/shared/cli";
import type { Settings } from "../src/settings";
import { resolveSettings } from "../src/settings";
import { readInspectorTask, rememberSelection } from "../src/inspector/selection";

const metadata = { thread_id: "chat-one", threadId: "chat-one" };
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zinn-selection-")));
  const settings: Settings = { store: join(directory, "store"), dataDirectory: join(directory, "integration"), cli: ["unused"], observe: false, identity: false, captureEffort: false };
  mkdirSync(settings.store);
  let result: CliResult = { ok: true, value: { key: "APP-1", title: "Current title" } };
  const calls: string[][] = [];
  const reader: CliReader = {
    async run<Value>(args: string[]): Promise<CliResult<Value>> { calls.push(args); return result as CliResult<Value>; },
    async close() {},
  };
  return { directory, settings, reader, calls, result: (value: CliResult) => { result = value; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("keyless restoration reads current task details and does not write state", async () => {
  const f = fixture();
  try {
    const empty = await readInspectorTask(f.settings, undefined, f.reader, metadata);
    expect(empty.kind).toBe("idle");
    expect(f.calls).toEqual([]);
    expect(existsSync(f.settings.dataDirectory)).toBe(false);
    expect(rememberSelection(f.settings, "app-1", empty.selection.scope!, metadata).saved).toBe(true);
    const directory = join(f.settings.dataDirectory, "selections");
    const files = readdirSync(directory);
    const path = join(directory, files[0]!);
    const bytes = readFileSync(path);
    expect(JSON.parse(bytes.toString())).toEqual({ version: 1, key: "APP-1" });
    expect(bytes.toString()).not.toContain(metadata.thread_id);
    f.result({ ok: true, value: { key: "APP-1", title: "Changed after selection" } });
    expect(await readInspectorTask(f.settings, undefined, f.reader, metadata)).toMatchObject({ kind: "ready", task: { title: "Changed after selection" } });
    expect(f.calls).toEqual([["task", "view", "APP-1"]]);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  } finally { f.cleanup(); }
});

test("chat/store context and expected scope isolate remembered keys", async () => {
  const f = fixture();
  try {
    const first = await readInspectorTask(f.settings, undefined, f.reader, metadata);
    const scope = first.selection.scope!;
    rememberSelection(f.settings, "APP-1", scope, metadata);
    const otherStore = { ...f.settings, store: join(f.directory, "other-store") };
    mkdirSync(otherStore.store);
    expect((await readInspectorTask(otherStore, undefined, f.reader, metadata)).kind).toBe("idle");
    expect(rememberSelection(otherStore, "APP-2", scope, metadata).saved).toBe(false);
    for (const binding of [undefined, { thread_id: "chat-two" }, { thread_id: "chat-one", threadId: "chat-two" }]) {
      expect((await readInspectorTask(f.settings, undefined, f.reader, binding)).kind).toBe("idle");
      expect(rememberSelection(f.settings, "APP-2", scope, binding).saved).toBe(false);
    }
    expect((await readInspectorTask(f.settings, "APP-1", f.reader)).kind).toBe("ready");
    expect(rememberSelection(f.settings, "not-a-key", scope, metadata).saved).toBe(false);
    expect((await readInspectorTask(f.settings, undefined, f.reader, { threadId: "chat-one" })).key).toBe("APP-1");
  } finally { f.cleanup(); }
});

test.skipIf(process.platform === "win32")("canonical store aliases share the remembered key", async () => {
  const f = fixture();
  try {
    const alias = join(f.directory, "store-alias");
    symlinkSync(f.settings.store, alias);
    const resolved = (await resolveSettings({ ...f.settings, store: alias })).settings;
    const initial = await readInspectorTask(f.settings, undefined, f.reader, metadata);
    rememberSelection(f.settings, "APP-1", initial.selection.scope!, metadata);
    expect((await readInspectorTask(resolved, undefined, f.reader, metadata)).key).toBe("APP-1");
  } finally { f.cleanup(); }
});

test("explicit opener, invalid input and transient errors preserve the stored key", async () => {
  const f = fixture();
  try {
    const initial = await readInspectorTask(f.settings, undefined, f.reader, metadata);
    rememberSelection(f.settings, "APP-1", initial.selection.scope!, metadata);
    f.result({ ok: true, value: { key: "APP-2", title: "Explicit opener" } });
    expect((await readInspectorTask(f.settings, "APP-2", f.reader, metadata)).key).toBe("APP-2");
    expect((await readInspectorTask(f.settings, "invalid", f.reader, metadata)).kind).toBe("invalid");
    f.result({ ok: false, error: "Temporary failure" });
    expect((await readInspectorTask(f.settings, "APP-2", f.reader, metadata)).kind).toBe("error");
    f.result({ ok: true, value: { key: "APP-1", title: "Still selected" } });
    expect((await readInspectorTask(f.settings, undefined, f.reader, metadata)).key).toBe("APP-1");
  } finally { f.cleanup(); }
});

test("a deleted selected task remains missing and recoverable on fresh reads", async () => {
  const f = fixture();
  try {
    const initial = await readInspectorTask(f.settings, undefined, f.reader, metadata);
    rememberSelection(f.settings, "APP-1", initial.selection.scope!, metadata);
    f.result({ ok: false, code: "not_found", entity: "task", error: "Missing task" });
    expect(await readInspectorTask(f.settings, undefined, f.reader, metadata)).toMatchObject({ kind: "missing", key: "APP-1" });
    f.result({ ok: true, value: { key: "APP-1", title: "Available again" } });
    expect((await readInspectorTask(f.settings, undefined, f.reader, metadata)).task?.title).toBe("Available again");
  } finally { f.cleanup(); }
});

test("malformed state is ignored without mutation and partial temporary files are ignored", async () => {
  const f = fixture();
  try {
    const initial = await readInspectorTask(f.settings, undefined, f.reader, metadata);
    rememberSelection(f.settings, "APP-1", initial.selection.scope!, metadata);
    const directory = join(f.settings.dataDirectory, "selections");
    const path = join(directory, readdirSync(directory)[0]!);
    writeFileSync(join(directory, ".selection-interrupted.tmp"), '{"version":');
    expect((await readInspectorTask(f.settings, undefined, f.reader, metadata)).key).toBe("APP-1");
    for (const value of ['{', JSON.stringify({ version: 2, key: "APP-1" }), JSON.stringify({ version: 1, key: "bad" }), ' '.repeat(2048)]) {
      writeFileSync(path, value);
      const result = await readInspectorTask(f.settings, undefined, f.reader, metadata);
      expect(result.kind).toBe("idle");
      expect(result.selection.warning).toBeDefined();
      expect(readFileSync(path, "utf8")).toBe(value);
      expect((await readInspectorTask(f.settings, "APP-1", f.reader, metadata)).kind).toBe("ready");
    }
  } finally { f.cleanup(); }
});

test.skipIf(process.platform === "win32")("failed state writes and reads do not prevent task inspection", async () => {
  const f = fixture();
  const directory = join(f.settings.dataDirectory, "selections");
  let path: string | undefined;
  try {
    const initial = await readInspectorTask(f.settings, undefined, f.reader, metadata);
    rememberSelection(f.settings, "APP-1", initial.selection.scope!, metadata);
    path = join(directory, readdirSync(directory)[0]!);
    chmodSync(directory, 0o500);
    expect(rememberSelection(f.settings, "APP-2", initial.selection.scope!, metadata).saved).toBe(false);
    expect((await readInspectorTask(f.settings, undefined, f.reader, metadata)).key).toBe("APP-1");
    chmodSync(path, 0o000);
    expect((await readInspectorTask(f.settings, undefined, f.reader, metadata)).selection.warning).toBeDefined();
    expect((await readInspectorTask(f.settings, "APP-1", f.reader, metadata)).kind).toBe("ready");
  } finally { if (path) { chmodSync(path, 0o600); } if (existsSync(directory)) { chmodSync(directory, 0o700); } f.cleanup(); }
});
