import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../build";
import { rewrite } from "../src/hooks/identity";
import { fromTranscript } from "../src/hooks/effort";
import type { HookPayload } from "../src/hooks/types";
import type { Settings } from "../src/settings";
import { readFeed, sessionDirectory, MAX_EVENTS, MAX_EVENT_BYTES, MAX_RECENT_KEYS, persist, type Observation } from "../src/shared/feed";
import { readRecent } from "../src/inspector/references";
import { loadSettings } from "../src/settings";
import { argvKeys, keyCandidates } from "../src/shared/keys";
import { fixture } from "./helpers";
const context = fixture();
const artifact = await build(join(context.directory, "artifact"));
const base = { session_id: "chat-one", cwd: context.directory, model: "fixture-model", agent_id: "child-one", agent_type: "reviewer", turn_id: "turn-one" };
afterAll(context.cleanup);
context.cli(["project", "create", "APP"]);
context.cli(["task", "create", "APP", "--title", "Literal <script>fixture</script>"]);
function observe(payload: HookPayload, settings: Settings) {
    const config = join(context.directory, "observation.json");
    writeFileSync(config, JSON.stringify(settings));
    const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: { ...context.env, ZINN_CODEX_CONFIG: config }, stdin: Buffer.from(JSON.stringify(payload)) });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.byteLength).toBe(0);
}
test("portable hook supplies scoped identity with the supported rewrite response", () => {
    const payload = { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ZINN_MODEL=explicit zinn task view APP-1", timeout_ms: 1234 } };
    const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: context.env, stdin: Buffer.from(JSON.stringify(payload)) });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString()).hookSpecificOutput;
    expect(output.hookEventName).toBe("PreToolUse");
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput.timeout_ms).toBe(1234);
    const command = output.updatedInput.command;
    expect(command).toContain("ZINN_MODEL='fixture-model'");
    expect(command).toEndWith(payload.tool_input.command);
    const events = context.cli(["activity", "list"]);
    const write = rewrite({ ...payload, tool_input: { command: `ZINN_MODEL=explicit ${context.settings.cli.join(" ")} task create APP --title 'Identity fixture'` } }, context.settings.cli) as any;
    const executed = Bun.spawnSync(["/bin/sh", "-c", write.hookSpecificOutput.updatedInput.command], {
        env: { ...context.env, CODEX_SESSION_ID: base.session_id, CODEX_THREAD_ID: base.agent_id, ZINN_EFFORT: "stale", CLAUDE_EFFORT: "stale" },
    });
    expect(executed.exitCode).toBe(0);
    const after = context.cli(["activity", "list"]);
    expect(after.length).toBe(events.length + 1);
    expect(after[0]).toMatchObject({ actor_model: "explicit", actor_agent: "reviewer", actor_effort: null, actor_session_id: "chat-one", actor_thread_id: "child-one" });
});
test("identity skips compound shells and safely quotes callback values", () => {
    for (const command of ["zinn info && false", "zinn info | cat", "zinn info > file", 'zinn info "$X"', "env zinn info", "echo zinn", "zinn info; false"]) {
        expect(rewrite({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, ["zinn"])).toBeNull();
    }
    const sentinel = join(context.directory, "must-not-execute");
    const model = `model'; touch '${sentinel}'; echo '`;
    const output: any = rewrite({ ...base, model, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "zinn info" } }, ["zinn"]);
    const command = output.hookSpecificOutput.updatedInput.command.replace(/zinn info$/, "sh -c 'printf \"%s\" \"$ZINN_MODEL\"'");
    const result = Bun.spawnSync(["/bin/sh", "-c", command], { env: context.env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(model);
    expect(existsSync(sentinel)).toBe(false);
});
test("hook input preserves Unicode across byte-stream boundaries", async () => {
    const command = "zinn task edit APP-1 --title '彩色🧡'";
    const input = Buffer.from(JSON.stringify({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }));
    const split = input.indexOf(Buffer.from("彩")) + 1;
    const child = Bun.spawn(["node", join(artifact.plugin, "hook.mjs")], { env: context.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(input.subarray(0, split));
    await Bun.sleep(100);
    child.stdin.write(input.subarray(split));
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).hookSpecificOutput.updatedInput.command).toEndWith(command);
});
test("effort requires exact thread, turn, model and a unique context", () => {
    const header = { type: "session_meta", payload: { id: base.agent_id } };
    const turn = { type: "turn_context", payload: { turn_id: base.turn_id, model: base.model, effort: "high" } };
    const text = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
    expect(fromTranscript(text(header, turn), base)).toEqual({ effort: "high", outcome: "matched" });
    expect(fromTranscript(text(header, turn, turn), base)).toEqual({ effort: null, outcome: "ambiguous" });
    expect(fromTranscript(text(header, turn), { ...base, model: "different" }).effort).toBeNull();
    expect(fromTranscript(text(header, turn), { ...base, agent_id: "another" }).effort).toBeNull();
    expect(fromTranscript(text(header, turn) + '\n{"type":', base).effort).toBeNull();
    const transcript = join(context.directory, "transcript.jsonl");
    writeFileSync(transcript, text(header, turn));
    const payload = { ...base, transcript_path: transcript, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "zinn info" } };
    const invoke = () => Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: context.env, stdin: Buffer.from(JSON.stringify(payload)) });
    expect(invoke().stdout.toString()).toContain("ZINN_EFFORT=''");
    writeFileSync(context.config, JSON.stringify({ ...context.settings, captureEffort: true }));
    expect(invoke().stdout.toString()).toContain("ZINN_EFFORT='high'");
    writeFileSync(context.config, JSON.stringify(context.settings));
});
test("references preserve chat and store isolation without retaining text", () => {
    const secret = "PRIVATE_TEXT_SENTINEL";
    observe({ ...base, hook_event_name: "Stop", last_assistant_message: `app-1 APP-999 UNRELATED-999 ${secret}` }, context.settings);
    observe({ ...base, session_id: "chat-two", hook_event_name: "Stop", last_assistant_message: "APP-2" }, context.settings);
    observe({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `ZINN_DIR=/other/store zinn task view APP-777` } }, context.settings);
    const first = readRecent(context.settings, { thread_id: base.session_id }, true);
    expect(first.references.map(item => item.key)).toEqual(["APP-1", "APP-999"]);
    expect(first.references[0]!.task?.title).toBe("Literal <script>fixture</script>");
    expect(first.references[1]!.task).toBeUndefined();
    expect(readRecent(context.settings, { threadId: "chat-two" }, true).references.map(item => item.key)).toEqual(["APP-2"]);
    expect(readRecent(context.settings, { thread_id: "one", threadId: "two" }).kind).toBe("conflicting_metadata");
    expect(readRecent(context.settings).kind).toBe("absent_metadata");
    const directory = sessionDirectory(context.settings.dataDirectory, base.session_id);
    const stored = readdirSync(directory).map(file => readFileSync(join(directory, file), "utf8")).join("");
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("fixture-model");
    expect(stored).not.toContain("UNRELATED-999");
    for (const file of readdirSync(directory)) {
        expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    }
});
test("uncertain directory changes do not attribute relative stores", () => {
    const payload = { ...base, session_id: "uncertain", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "cd /missing; ZINN_DIR=relative zinn task view APP-1" } };
    observe(payload, context.settings);
    expect(readFeed(context.settings.dataDirectory, "uncertain", context.settings.store).references).toEqual([]);
    const input = { ...base, session_id: "other-default-store", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "zinn task view APP-1" } };
    const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: { ...context.env, ZINN_DIR: "/other/store" }, stdin: Buffer.from(JSON.stringify(input)) });
    expect(result.exitCode).toBe(0);
    expect(readFeed(context.settings.dataDirectory, input.session_id, context.settings.store).references).toEqual([]);
});
test("observer verification runs configured CLI processes with writes denied", () => {
    const sentinel = join(context.directory, "observer-must-not-write");
    const executable = join(context.directory, "writing-cli.mjs");
    writeFileSync(executable, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'forbidden'); console.log('[]');`);
    observe({ ...base, session_id: "protected-observer", hook_event_name: "Stop", last_assistant_message: "APP-1" }, { ...context.settings, cli: ["node", executable] });
    expect(existsSync(sentinel)).toBe(false);
    const feed = readFeed(context.settings.dataDirectory, "protected-observer", context.settings.store);
    expect(feed.references).toEqual([]);
    expect(feed.replyFailures).toBe(1);
});
test("key scanning accepts the CLI number range and excludes free-text arguments", () => {
    expect(argvKeys(["LONGPROJECTPREFIX123-123456789012345"])).toEqual(["LONGPROJECTPREFIX123-123456789012345"]);
    expect(keyCandidates("app-123456789012345", true)).toEqual(["APP-123456789012345"]);
    expect(argvKeys(["APP-0", "APP-1234567890123456"])).toEqual([]);
    observe({ ...base, session_id: "redacted-arguments", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "zinn task edit APP-1 --title APP-999 --description 'APP-777'" } }, context.settings);
    expect(readFeed(context.settings.dataDirectory, "redacted-arguments", context.settings.store).references.map(item => item.key)).toEqual(["APP-1"]);
});
test("missing configuration, disabled hooks and malformed input leave operations unchanged", () => {
    const payload = JSON.stringify({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "zinn info" } });
    for (const [input, config] of [["broken json", context.config], [payload, join(context.directory, "missing.json")]]) {
        const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: { ...context.env, ZINN_CODEX_CONFIG: config }, stdin: Buffer.from(input!) });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.byteLength).toBe(0);
        expect(result.stderr.byteLength).toBe(0);
    }
    writeFileSync(context.config, JSON.stringify({ ...context.settings, identity: false, observe: false }));
    const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: context.env, stdin: Buffer.from(payload) });
    expect(result.stdout.byteLength).toBe(0);
    writeFileSync(context.config, JSON.stringify(context.settings));
});
test("configuration rejects relative paths and data paths inside the database directory", () => {
    const config = join(context.directory, "invalid.json");
    const load = () => loadSettings({ ZINN_CODEX_CONFIG: config });
    writeFileSync(config, JSON.stringify({ store: "relative" }));
    expect(load).toThrow();
    const alias = join(context.directory, "store-alias");
    symlinkSync(context.settings.store, alias);
    writeFileSync(config, JSON.stringify({ store: context.settings.store, dataDirectory: join(alias, "references") }));
    expect(load).toThrow();
});
test("feed bounds, partial writes and recent-key limits are reported", () => {
    const observation: Observation = { version: 1, session: "capacity", ts: "2026-01-01T00:00:00Z", references: [], replyFailedStore: null };
    const directory = join(context.directory, "capacity");
    expect(persist(directory, observation)).toBe(true);
    const session = sessionDirectory(directory, observation.session);
    for (let index = 1; index < MAX_EVENTS; index++) {
        writeFileSync(join(session, `${String(index).padStart(4, "0")}.json`), "partial");
    }
    expect(persist(directory, observation)).toBe(false);
    const feed = readFeed(directory, observation.session, context.settings.store);
    expect(feed.atCapacity).toBe(true);
    expect(feed.incomplete).toBe(MAX_EVENTS - 1);
    expect(persist(directory, { ...observation, session: "oversized", references: [{ key: "x".repeat(MAX_EVENT_BYTES), source: "argv", store: context.settings.store }] })).toBe(false);
    const references = Array.from({ length: MAX_RECENT_KEYS + 3 }, (_, index) => ({ key: `APP-${index + 1}`, source: "argv" as const, store: context.settings.store }));
    expect(persist(directory, { ...observation, session: "recent-limit", references })).toBe(true);
    expect(readFeed(directory, "recent-limit", context.settings.store).references).toHaveLength(MAX_RECENT_KEYS);
});
