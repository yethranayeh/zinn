import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../build";
import { rewrite } from "../src/hooks/identity";
import { fromTranscript } from "../src/hooks/effort";
import type { HookPayload } from "../src/hooks/types";
import type { Settings } from "../src/settings";
import { readFeed, sessionDirectory, MAX_EVENTS, MAX_EVENT_BYTES, MAX_RECENT_KEYS, persist, type Observation } from "../src/shared/feed";
import { readRecent } from "../src/inspector/references";
import { createCliReader } from "../src/shared/cli";
import { loadSettings } from "../src/settings";
import { argvKeys, keyCandidates } from "../src/shared/keys";
import { cliPath, fixture, inspectStore, seedOlderStore } from "./helpers";
import { infoDatabaseStateSchema } from "../../../packages/core/src/operations/info";
import { fromJSONSchema } from "zod/v4";
import { EVENTS } from "../src/hooks/observe";
const context = fixture();
const reader = createCliReader(context.settings);
afterAll(() => reader.close());
const artifact = await build(join(context.directory, "artifact"));
const codexHookSchemas = join(import.meta.dir, "fixtures/codex-hooks-0.166.0-alpha.5.1");
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
test("hook inputs and emitted responses match the pinned Codex schemas", () => {
    const cases: Record<(typeof EVENTS)[number], { input: Record<string, unknown>; expectsResponse: boolean }> = {
        PreToolUse: {
            input: {
                ...base,
                hook_event_name: "PreToolUse",
                permission_mode: "default",
                tool_name: "Bash",
                tool_use_id: "tool-one",
                transcript_path: null,
                tool_input: { command: "zinn info" },
            },
            expectsResponse: true,
        },
        PostToolUse: {
            input: {
                cwd: context.directory,
                hook_event_name: "PostToolUse",
                model: "fixture-model",
                permission_mode: "default",
                session_id: "chat-one",
                tool_input: { command: "echo unrelated" },
                tool_name: "Bash",
                tool_response: {},
                tool_use_id: "tool-one",
                transcript_path: null,
                turn_id: "turn-one",
            },
            expectsResponse: false,
        },
        Stop: {
            input: {
                cwd: context.directory,
                hook_event_name: "Stop",
                last_assistant_message: null,
                model: "fixture-model",
                permission_mode: "default",
                session_id: "chat-one",
                stop_hook_active: false,
                transcript_path: null,
                turn_id: "turn-one",
            },
            expectsResponse: true,
        },
        SubagentStop: {
            input: {
                agent_id: "child-one",
                agent_transcript_path: null,
                agent_type: "reviewer",
                cwd: context.directory,
                hook_event_name: "SubagentStop",
                last_assistant_message: null,
                model: "fixture-model",
                permission_mode: "default",
                session_id: "chat-one",
                stop_hook_active: false,
                transcript_path: null,
                turn_id: "turn-one",
            },
            expectsResponse: true,
        },
    };

    for (const event of EVENTS) {
        const { input, expectsResponse } = cases[event];
        const schemaName = event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
        const inputSchema = fromJSONSchema(JSON.parse(readFileSync(join(codexHookSchemas, `${schemaName}.command.input.schema.json`), "utf8")));
        expect(inputSchema.safeParse(input).success).toBe(true);

        const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: context.env, stdin: Buffer.from(JSON.stringify(input)) });
        expect(result.exitCode).toBe(0);
        expect(result.stderr.byteLength).toBe(0);

        if (expectsResponse) {
            const outputSchema = fromJSONSchema(JSON.parse(readFileSync(join(codexHookSchemas, `${schemaName}.command.output.schema.json`), "utf8")));
            expect(outputSchema.safeParse(JSON.parse(result.stdout.toString())).success).toBe(true);
        } else {
            expect(result.stdout.byteLength).toBe(0);
        }
    }
});
test.skipIf(process.platform === "win32")("hook supplies scoped identity through the supported Unix shell rewrite", () => {
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
test.skipIf(process.platform === "win32")("identity skips compound shells and safely quotes Unix shell callback values", () => {
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
test("references preserve chat and store isolation without retaining text", async () => {
    const secret = "PRIVATE_TEXT_SENTINEL";
    observe({ ...base, hook_event_name: "Stop", last_assistant_message: `app-1 APP-999 UNRELATED-999 ${secret}` }, context.settings);
    observe({ ...base, session_id: "chat-two", hook_event_name: "Stop", last_assistant_message: "APP-2" }, context.settings);
    observe({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `ZINN_DIR=/other/store zinn task view APP-777` } }, context.settings);
    const first = await readRecent(context.settings, reader, { thread_id: base.session_id });
    expect(first.references.map(item => item.key)).toEqual(["APP-1", "APP-999"]);
    expect(first.references[0]!.task?.title).toBe("Literal <script>fixture</script>");
    expect(first.references[1]!.task).toBeUndefined();
    expect((await readRecent(context.settings, reader, { threadId: "chat-two" })).references.map(item => item.key)).toEqual(["APP-2"]);
    expect((await readRecent(context.settings, reader, { thread_id: "one", threadId: "two" })).kind).toBe("conflicting_metadata");
    expect((await readRecent(context.settings, reader)).kind).toBe("absent_metadata");
    const directory = sessionDirectory(context.settings.dataDirectory, base.session_id);
    const stored = readdirSync(directory).map(file => readFileSync(join(directory, file), "utf8")).join("");
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("fixture-model");
    expect(stored).not.toContain("UNRELATED-999");
    if (process.platform !== "win32") {
        // Windows does not distinguish owner, group, and other mode bits: https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#file-modes
        for (const file of readdirSync(directory)) {
            expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
        }
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
test.skipIf(process.platform === "win32")("inherited relative stores stay unknown after directory changes and conditional effects", () => {
    const origin = join(context.directory, "relative-origin");
    const other = join(context.directory, "relative-other");
    const firstStore = join(origin, "store");
    const secondStore = join(other, "store");
    const missing = join(context.directory, "missing-directory");
    for (const [store, title] of [[firstStore, "Origin task"], [secondStore, "Other task"]] as const) {
        mkdirSync(store, { recursive: true });
        context.cli(["project", "create", "APP"], store);
        context.cli(["task", "create", "APP", "--title", title], store);
    }
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const view = [...context.settings.cli, "task", "view", "APP-1", "--json"].map(quote).join(" ");
    const cases = [
        { name: "unchanged", command: view, title: "Origin task", recorded: firstStore },
        { name: "successful-cd", command: `cd ${quote(other)} && ${view}`, title: "Other task", recorded: null },
        { name: "failed-cd", command: `cd ${quote(missing)}; ${view}`, title: "Origin task", recorded: null },
        { name: "unreached-cd", command: `false && cd ${quote(other)}; ${view}`, title: "Origin task", recorded: null },
        { name: "fallback-cd", command: `cd ${quote(missing)} || cd ${quote(other)}; ${view}`, title: "Other task", recorded: null },
        { name: "conditional-cd", command: `if true; then cd ${quote(other)}; fi; ${view}`, title: "Other task", recorded: null },
        { name: "conditional-cd-test", command: `if cd ${quote(other)}; then :; fi; ${view}`, title: "Other task", recorded: null },
        { name: "conditional-cd-else", command: `if false; then :; elif false; then :; else cd ${quote(other)}; fi; ${view}`, title: "Other task", recorded: null },
        { name: "subshell-cd", command: `(cd ${quote(other)}; ${view})`, title: "Other task", recorded: null },
        { name: "after-subshell", command: `(cd ${quote(other)}); ${view}`, title: "Origin task", recorded: null },
        { name: "inherited-absolute", command: `cd ${quote(other)} && ${view}`, inherited: firstStore, title: "Origin task", recorded: firstStore },
        { name: "absolute-override", command: `cd ${quote(other)} && ZINN_DIR=${quote(firstStore)} ${view}`, title: "Origin task", recorded: firstStore },
        { name: "relative-override", command: `ZINN_DIR=../relative-other/store ${view}`, title: "Other task", recorded: secondStore },
        { name: "exported-store", command: `export ZINN_DIR=${quote(secondStore)}; ${view}`, title: "Other task", recorded: null },
        { name: "conditional-export", command: `if true; then export ZINN_DIR=${quote(secondStore)}; fi; ${view}`, title: "Other task", recorded: null },
        { name: "assigned-store", command: `ZINN_DIR=${quote(secondStore)}; ${view}`, title: "Other task", recorded: null },
        { name: "conditional-assignment", command: `if true; then ZINN_DIR=${quote(secondStore)}; fi; ${view}`, title: "Other task", recorded: null },
        { name: "unset-override", command: `unset ZINN_DIR; ZINN_DIR=${quote(secondStore)} ${view}`, title: "Other task", recorded: secondStore },
        { name: "literal-cd-argument", command: `: cd; ${view}`, title: "Origin task", recorded: firstStore },
    ];
    for (const scenario of cases) {
        const env = { ...context.env, ZINN_DIR: scenario.inherited ?? "./store" };
        const executed = Bun.spawnSync(["/bin/sh", "-c", scenario.command], { cwd: origin, env });
        expect(executed.exitCode).toBe(0);
        expect(JSON.parse(executed.stdout.toString()).title).toBe(scenario.title);
        const session = `inherited-relative-${scenario.name}`;
        const payload = { ...base, cwd: origin, session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: scenario.command } };
        const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env, stdin: Buffer.from(JSON.stringify(payload)) });
        expect(result.exitCode).toBe(0);
        expect(result.stderr.byteLength).toBe(0);
        if (scenario.recorded === null) {
            expect(existsSync(sessionDirectory(context.settings.dataDirectory, session)), scenario.name).toBe(false);
        } else {
            expect(readFeed(context.settings.dataDirectory, session, scenario.recorded).references).toEqual([{ key: "APP-1", source: "argv", store: scenario.recorded }]);
        }
    }
});
test("observer refuses unsupported CLI versions before database verification", () => {
    for (const [index, version] of ["0.42.0", "0.42.0-dev", "0.43.0-dev", "0.44.0-rc.1", "00.44.0-dev", "unknown"].entries()) {
        const sentinel = join(context.directory, `unexpected-store-open-${index}`);
        const executable = join(context.directory, `old-cli-${index}.mjs`);
        writeFileSync(executable, `import {writeFileSync} from 'node:fs'; if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); } else { writeFileSync(${JSON.stringify(sentinel)}, 'unexpected'); }`);
        const session = `unsupported-observer-${index}`;
        observe({ ...base, session_id: session, hook_event_name: "Stop", last_assistant_message: "APP-1" }, { ...context.settings, cli: ["node", executable] });
        expect(existsSync(sentinel)).toBe(false);
        const feed = readFeed(context.settings.dataDirectory, session, context.settings.store);
        expect(feed.references).toEqual([]);
        expect(feed.replyFailures).toBe(1);
    }
});
test("observer verifies references with stable releases and newer canonical development builds", () => {
    for (const [index, version] of ["0.43.0", "0.43.1-dev", "0.44.0-dev", "1.0.0-dev"].entries()) {
        const executable = join(context.directory, `supported-cli-${index}.mjs`);
        writeFileSync(executable, `import {spawnSync} from 'node:child_process';
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); }
else {
    const result = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], {env:process.env});
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
}`);
        const session = `supported-observer-${index}`;
        observe({ ...base, session_id: session, hook_event_name: "Stop", last_assistant_message: "APP-1" }, { ...context.settings, cli: ["node", executable] });
        const feed = readFeed(context.settings.dataDirectory, session, context.settings.store);
        expect(feed.references).toEqual([{ key: "APP-1", source: "completed-reply", store: context.settings.store }]);
        expect(feed.replyFailures).toBe(0);
    }
});
test("optional verification skips older schemas without starting an upgrade", () => {
    const store = join(context.directory, "older-store");
    seedOlderStore(store);
    const before = inspectStore(store);
    observe({ ...base, session_id: "older-observer", hook_event_name: "Stop", last_assistant_message: "APP-1" }, { ...context.settings, store });
    expect(inspectStore(store)).toEqual(before);
    expect(existsSync(join(store, "backups"))).toBe(false);
    expect(readFeed(context.settings.dataDirectory, "older-observer", store).replyFailures).toBe(1);
});
test("optional verification skips non-current and unavailable preflight results", () => {
    for (const state of infoDatabaseStateSchema.options.filter(state => state !== "current")) {
        const log = join(context.directory, `preflight-${state}.jsonl`);
        const script = join(context.directory, `preflight-${state}.mjs`);
        writeFileSync(script, `import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('0.43.0'); }
else { console.log(JSON.stringify({database:{state:${JSON.stringify(state)},error:${state === "unavailable" ? "'fixture failure'" : "null"}}})); }`);
        observe({ ...base, session_id: `preflight-${state}`, hook_event_name: "Stop", last_assistant_message: "APP-1" }, { ...context.settings, cli: ["node", script] });
        expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([["--version"], ["info", "--json"]]);
        expect(readFeed(context.settings.dataDirectory, `preflight-${state}`, context.settings.store).replyFailures).toBe(1);
    }
});
test("hook verification shares one deadline across version, info and task lookup", () => {
    const log = join(context.directory, "budget.jsonl");
    const script = join(context.directory, "slow-verification.mjs");
    writeFileSync(script, `import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
setTimeout(() => { if (args[0] === '--version') { console.log('0.43.0'); }
else if (args[0] === 'info') { console.log(JSON.stringify({database:{state:'current',error:null}})); }
else { console.log('[]'); } }, 600);`);
    const began = performance.now();
    observe({ ...base, session_id: "budget", hook_event_name: "Stop", last_assistant_message: "APP-1" }, { ...context.settings, cli: ["node", script] });
    expect(performance.now() - began).toBeLessThan(3000);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toContainEqual(["info", "--json"]);
    expect(calls.some(args => args[0] === "task")).toBe(false);
    expect(readFeed(context.settings.dataDirectory, "budget", context.settings.store).replyFailures).toBe(1);
});
test("key scanning accepts the CLI number range and excludes free-text arguments", () => {
    expect(argvKeys(["LONGPROJECTPREFIX123-123456789012345"])).toEqual(["LONGPROJECTPREFIX123-123456789012345"]);
    expect(keyCandidates("app-123456789012345", true)).toEqual(["APP-123456789012345"]);
    expect(argvKeys(["APP-0", "APP-1234567890123456"])).toEqual([]);
    observe({ ...base, session_id: "redacted-arguments", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "zinn task edit APP-1 --title APP-999 --description 'APP-777'" } }, context.settings);
    expect(readFeed(context.settings.dataDirectory, "redacted-arguments", context.settings.store).references.map(item => item.key)).toEqual(["APP-1"]);
});
test("optional configuration uses the fixed-home file before the legacy file", () => {
    const home = join(context.directory, "settings-home");
    mkdirSync(home);
    expect(loadSettings({}, home)).toMatchObject({ store: undefined, cli: ["zinn"], identity: true, observe: true });
    expect(existsSync(join(home, ".zinn"))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);

    mkdirSync(join(home, ".config/zinn"), { recursive: true });
    writeFileSync(join(home, ".config/zinn/codex.json"), JSON.stringify(context.settings));
    expect(loadSettings({}, home)).toMatchObject(context.settings);

    const customStore = join(home, "custom-store");
    mkdirSync(join(home, ".zinn/integrations"), { recursive: true });
    mkdirSync(join(customStore, "integrations"), { recursive: true });
    writeFileSync(join(home, ".zinn/integrations/codex.json"), JSON.stringify({ observe: false }));
    writeFileSync(join(customStore, "integrations/codex.json"), JSON.stringify({ identity: false, cli: ["store-cli"] }));
    expect(loadSettings({ ZINN_DIR: customStore }, home)).toMatchObject({
        store: undefined,
        cli: ["zinn"],
        identity: true,
        observe: false,
    });

    const explicit = join(context.directory, "explicit-options.json");
    writeFileSync(explicit, JSON.stringify({ identity: false, cli: ["explicit-cli"] }));
    expect(loadSettings({ ZINN_DIR: customStore, ZINN_CODEX_CONFIG: explicit }, home)).toMatchObject({
        store: undefined,
        cli: ["explicit-cli"],
        identity: false,
        observe: true,
    });

    writeFileSync(join(home, ".zinn/integrations/codex.json"), "invalid json");
    expect(() => loadSettings({ ZINN_DIR: customStore }, home)).toThrow();
    expect(loadSettings({ ZINN_CODEX_CONFIG: explicit }, home).cli).toEqual(["explicit-cli"]);
    expect(() => loadSettings({ ZINN_DIR: customStore, ZINN_CODEX_CONFIG: join(context.directory, "missing-options.json") }, home)).toThrow();
    writeFileSync(explicit, "invalid json");
    expect(() => loadSettings({ ZINN_DIR: customStore, ZINN_CODEX_CONFIG: explicit }, home)).toThrow();
    rmSync(join(home, ".zinn/integrations/codex.json"));
    mkdirSync(join(home, ".zinn/integrations/codex.json"));
    expect(() => loadSettings({}, home)).toThrow();
    expect(readFileSync(join(home, ".config/zinn/codex.json"), "utf8")).toBe(JSON.stringify(context.settings));
});

test("configuration-free identity works when the CLI is unavailable and observations fail neutrally", () => {
    const home = join(context.directory, "identity-home");
    const noExecutables = join(home, "empty-bin");
    mkdirSync(noExecutables, { recursive: true });
    const env = { ...context.env, HOME: home, USERPROFILE: home, ZINN_CODEX_CONFIG: undefined, ZINN_DIR: undefined, PATH: noExecutables };
    const node = Bun.which("node")!;
    const invoke = (payload: HookPayload) => Bun.spawnSync([node, join(artifact.plugin, "hook.mjs")], { env, stdin: Buffer.from(JSON.stringify(payload)) });
    const identity = invoke({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "zinn task view APP-1" } });
    expect(identity.exitCode).toBe(0);
    expect(identity.stderr.byteLength).toBe(0);
    expect(JSON.parse(identity.stdout.toString()).hookSpecificOutput).toMatchObject({ permissionDecision: "allow", updatedInput: { command: expect.stringContaining("ZINN_MODEL=") } });
    const stop = invoke({ ...base, hook_event_name: "Stop", last_assistant_message: "APP-1" });
    expect(stop.exitCode).toBe(0);
    expect(stop.stderr.byteLength).toBe(0);
    expect(JSON.parse(stop.stdout.toString())).toEqual({});
    expect(existsSync(join(home, ".zinn"))).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
});

test("default-store discovery shares the observer deadline", () => {
    const script = join(context.directory, "default-budget.mjs");
    const log = join(context.directory, "default-budget.jsonl");
    writeFileSync(script, `import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
setTimeout(() => { if (args[0] === '--version') { console.log('0.43.0'); }
else { console.log(JSON.stringify({storage:{directory:${JSON.stringify(context.settings.store)},error:null},database:{state:'current',error:null}})); } }, 600);`);
    const config = join(context.directory, "default-budget-config.json");
    const { store: _store, ...options } = context.settings;
    writeFileSync(config, JSON.stringify({ ...options, cli: ["node", script] }));
    const began = performance.now();
    const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env: { ...context.env, ZINN_CODEX_CONFIG: config }, stdin: Buffer.from(JSON.stringify({ ...base, session_id: "default-budget", hook_event_name: "Stop", last_assistant_message: "APP-1" })) });
    expect(result.exitCode).toBe(0);
    expect(performance.now() - began).toBeLessThan(3000);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toContainEqual(["info", "--json"]);
    expect(calls.some(args => args[0] === "task")).toBe(false);
    expect(readFeed(context.settings.dataDirectory, "default-budget", context.settings.store).replyFailures).toBe(1);
});

test("command observations follow global and project storage settings", () => {
    const home = join(context.directory, "command-home");
    const workspace = join(context.directory, "command-workspace");
    const localStore = join(context.directory, "command-local-store");
    mkdirSync(join(home, ".zinn"), { recursive: true });
    mkdirSync(workspace);
    mkdirSync(localStore);
    writeFileSync(join(home, ".zinn/settings.json"), JSON.stringify({ storage: { directory: context.settings.store } }));
    const config = join(context.directory, "command-options.json");
    const { store: _store, ...options } = context.settings;
    writeFileSync(config, JSON.stringify(options));
    const env = { ...context.env, HOME: home, USERPROFILE: home, ZINN_DIR: undefined, ZINN_CODEX_CONFIG: config };
    for (const selection of ["global", "project"]) {
        if (selection === "project") {
            writeFileSync(join(workspace, "zinn.local.json"), JSON.stringify({ storage: { directory: localStore } }));
        }
        const session = `command-${selection}`;
        const payload = { ...base, session_id: session, cwd: workspace, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "zinn task view APP-1" } };
        const result = Bun.spawnSync(["node", join(artifact.plugin, "hook.mjs")], { env, stdin: Buffer.from(JSON.stringify(payload)) });
        expect(result.exitCode).toBe(0);
        expect(result.stderr.byteLength).toBe(0);
        const store = selection === "project" ? localStore : context.settings.store;
        expect(readFeed(context.settings.dataDirectory, session, store).references.map(item => item.key)).toEqual(["APP-1"]);
        expect(readFeed(context.settings.dataDirectory, session, join(home, ".zinn")).references).toEqual([]);
    }
    expect(existsSync(join(localStore, "data"))).toBe(false);
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
    for (const value of [null, [], true, 1, "value"]) {
        writeFileSync(config, JSON.stringify(value));
        expect(load).toThrow();
    }
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
