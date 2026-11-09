import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { packageIntegration } from "../package";
import { INSPECTOR_VERSION } from "../src/runtime";
import { EVENTS } from "../src/hooks/observe";
import { CODEX_CLIENT } from "../src/shared/cli";
import { persist, type Observation } from "../src/shared/feed";
import { openDatabase } from "../../../packages/core/src/sqlite/bun.ts";
import { latestVersion, MIGRATIONS } from "../../../packages/core/src/migrations/registry.ts";
import { cliPath, fixture, inspectStore, repository, seedOlderStore, waitFor } from "./helpers";
const context = fixture();
const buildDirectory = join(context.directory, "build");
const packaged = await packageIntegration(buildDirectory, join(context.directory, "release"));
const extracted = join(context.directory, "relocated marketplace with spaces");
await new Bun.Archive(await Bun.file(packaged.archive).arrayBuffer()).extract(extracted);
rmSync(buildDirectory, { recursive: true });
const artifact = { plugin: join(extracted, "zinn-codex/plugins/zinn") };
afterAll(context.cleanup);
context.cli(["project", "create", "APP"]);
context.cli(["task", "create", "APP", "--title", "Literal <script>fixture</script>", "--description", "First line\n<script>literal text</script>"]);
context.cli(["task", "create", "APP", "--title", "Archived fixture"]);
context.cli(["task", "archive", "APP-2"]);
context.cli(["task", "create", "APP", "--title", "Related fixture"]);
context.cli(["task", "relation", "create", "APP-1", "APP-3", "--type", "related"]);
context.cli(["task", "comment", "create", "APP-1", "--text", "Literal <img src=x> comment"]);
for (const [session, key] of [["chat-one", "APP-1"], ["chat-two", "APP-2"]]) {
    persist(context.settings.dataDirectory, { version: 1, session, ts: new Date().toISOString(), references: [{ key, source: "argv", store: context.settings.store }], replyFailedStore: null } as Observation);
}
const resource = `ui://zinn/inspector-${INSPECTOR_VERSION}.html`;
function fingerprint() {
    const directory = join(context.settings.store, "data");
    return readdirSync(directory).sort().map(file => [file, createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")]);
}
function actorEnvironmentNames() {
    const source = readFileSync(join(repository, "packages/cli/src/actor.ts"), "utf8");
    const markerBlock = source.match(/const AGENT_MARKERS[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
    const sessionBlock = source.match(/const SESSION_DECLARATIONS = \[([\s\S]*?)\] as const;/)?.[1];
    const identityBlock = source.match(/function readExecutionIdentity[\s\S]*?\n\}/)?.[0];
    expect(markerBlock).toBeDefined();
    expect(sessionBlock).toBeDefined();
    expect(identityBlock).toBeDefined();
    const markers = [...markerBlock!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map(match => match[1]!);
    const declarations = [...sessionBlock!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map(match => match[1]!);
    const identity = [...identityBlock!.matchAll(/readDeclaration\(env, "([A-Z][A-Z0-9_]*)"\)/g)].map(match => match[1]!);
    return [...new Set([...markers, ...declarations, ...identity])].sort();
}
async function connect(config = context.config, overrides: NodeJS.ProcessEnv = {}, cwd = context.directory) {
    const client = new Client({ name: "zinn-artifact-check", version: "1.0.0" });
    const env = Object.fromEntries(Object.entries({ ...context.env, ZINN_CODEX_CONFIG: config, ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ command: "node", args: [join(artifact.plugin, "launcher.mjs")], cwd, env });
    try {
        await client.connect(transport);
    } catch (error) {
        await client.close();
        throw error;
    }
    return client;
}
test("relocated panel loads fixed-home options and preserves an explicit inspector store", async () => {
    const home = join(context.directory, "canonical-options-home");
    const unrelatedStore = join(context.directory, "canonical-options-unselected-store");
    mkdirSync(join(home, ".zinn/integrations"), { recursive: true });
    mkdirSync(join(home, ".config/zinn"), { recursive: true });
    writeFileSync(join(home, ".zinn/integrations/codex.json"), JSON.stringify(context.settings));
    const legacy = join(home, ".config/zinn/codex.json");
    writeFileSync(legacy, "invalid json");
    const client = await connect(context.config, {
        HOME: home, USERPROFILE: home, ZINN_CODEX_CONFIG: undefined, ZINN_DIR: unrelatedStore,
    }, artifact.plugin);
    try {
        const response = await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } });
        expect(response.structuredContent).toMatchObject({
            kind: "ready", store: context.settings.store, task: { key: "APP-1" },
        });
        expect(existsSync(unrelatedStore)).toBe(false);
        expect(existsSync(join(home, ".zinn/data"))).toBe(false);
        expect(readFileSync(legacy, "utf8")).toBe("invalid json");
    } finally {
        await client.close();
    }
});
test.skipIf(process.platform === "win32")("configuration-free panel uses the Unix PATH and resolves stores independently of plugin cwd", async () => {
    const bin = join(context.directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "zinn"), `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(cliPath).href)});\n`, { mode: 0o755 });
    const localSettings = join(artifact.plugin, "zinn.local.json");
    const unrelatedStore = join(context.directory, "plugin-context-store");
    writeFileSync(localSettings, JSON.stringify({ storage: { directory: unrelatedStore } }));
    try {
        for (const selection of ["default", "global", "environment", "relative-environment", "older", "absent"]) {
            const home = join(context.directory, `home-${selection}`);
            mkdirSync(join(home, ".zinn"), { recursive: true });
            const store = selection === "relative-environment"
                ? join(home, "relative-store")
                : selection === "global" || selection === "environment"
                    ? join(context.directory, `${selection}-selected-store`)
                    : join(home, ".zinn");
            mkdirSync(store, { recursive: true });
            if (selection === "older") {
                seedOlderStore(store);
            } else if (selection !== "absent") {
                context.cli(["project", "create", "APP"], store);
                context.cli(["task", "create", "APP", "--title", `${selection} task`], store);
            }
            if (selection === "global" || selection === "environment") {
                writeFileSync(join(home, ".zinn/settings.json"), JSON.stringify({ storage: { directory: selection === "environment" ? unrelatedStore : store } }));
            }
            const env = {
                HOME: home, USERPROFILE: home, ZINN_CODEX_CONFIG: undefined,
                ZINN_DIR: selection === "relative-environment" ? "./relative-store" : selection === "environment" ? store : undefined,
                PATH: `${bin}:${process.env.PATH}`,
            };
            let ordinaryState;
            let ordinaryTask;
            if (selection === "older") {
                const control = Bun.spawnSync(["node", cliPath, "task", "view", "APP-1", "--json"], { env: { ...context.env, ...env, ZINN_DIR: store } });
                expect(control.exitCode).toBe(0);
                ordinaryTask = JSON.parse(control.stdout.toString());
                ordinaryState = inspectStore(store);
            }
            const client = await connect(context.config, env, artifact.plugin);
            try {
                const result = (await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent as any;
                expect(result.store).toBe(store);
                expect(result.kind).toBe(selection === "absent" ? "error" : "ready");
                expect(existsSync(join(home, ".config/zinn/codex.json"))).toBe(false);
                if (selection === "older") {
                    expect(result.task).toEqual(ordinaryTask);
                    expect(inspectStore(store)).toEqual(ordinaryState!);
                    expect(existsSync(join(store, "backups"))).toBe(false);
                }
                if (selection === "absent") {
                    expect(existsSync(join(store, "data/zinn.sqlite"))).toBe(false);
                }
            } finally {
                await client.close();
            }
        }
        expect(existsSync(unrelatedStore)).toBe(false);
        const badHome = join(context.directory, "invalid-home");
        mkdirSync(join(badHome, ".zinn"), { recursive: true });
        writeFileSync(join(badHome, ".zinn/settings.json"), "broken json");
        await expect(connect(context.config, { HOME: badHome, USERPROFILE: badHome, ZINN_DIR: undefined, ZINN_CODEX_CONFIG: undefined, PATH: `${bin}:${process.env.PATH}` }, artifact.plugin)).rejects.toThrow();
        expect(existsSync(join(badHome, ".zinn/data"))).toBe(false);
    } finally {
        rmSync(localSettings);
    }
}, 30000);

test("an options file can omit store and explicit store selection retains precedence", async () => {
    const config = join(context.directory, "options-without-store.json");
    const { store: _store, ...options } = context.settings;
    writeFileSync(config, JSON.stringify(options));
    const discovered = await connect(config);
    try {
        expect((await discovered.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent).toMatchObject({ kind: "ready", store: context.settings.store });
    } finally {
        await discovered.close();
    }
    const pinned = await connect(context.config, { ZINN_DIR: join(context.directory, "wrong-inherited-store") });
    try {
        expect((await pinned.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent).toMatchObject({ kind: "ready", store: context.settings.store });
    } finally {
        await pinned.close();
    }
});

test("closing during store discovery reaps its owned child", async () => {
    const marker = join(context.directory, "discovery-child.json");
    const script = join(context.directory, "pending-discovery.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
if (process.argv[2] === '--version') { console.log('0.43.0'); }
else { process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000); }`);
    const config = join(context.directory, "pending-discovery.json");
    writeFileSync(config, JSON.stringify({ cli: ["node", script] }));
    const client = new Client({ name: "zinn-startup-check", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: "node", args: [join(artifact.plugin, "launcher.mjs")], env: { ...context.env as Record<string, string>, ZINN_CODEX_CONFIG: config } });
    const connecting = client.connect(transport).catch(() => undefined);
    try {
        await waitFor(() => existsSync(marker));
        const pid = JSON.parse(readFileSync(marker, "utf8")).pid;
        await client.close();
        await connecting;
        await waitFor(() => {
            try {
                process.kill(pid, 0);
                return false;
            } catch {
                return true;
            }
        });
    } finally {
        await client.close();
    }
});

test("artifact contains only portable bundled assets and dependency notices", () => {
    expect(createHash("sha256").update(readFileSync(packaged.archive)).digest("hex")).toBe(packaged.sha256);
    expect(existsSync(join(extracted, "zinn-codex/tests"))).toBe(false);
    expect(existsSync(join(artifact.plugin, "plugin.json"))).toBe(false);
    expect(existsSync(join(artifact.plugin, "mcp.json"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(artifact.plugin, ".codex-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("zinn");
    expect(manifest.version).toBe(INSPECTOR_VERSION);
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    const hooks = JSON.parse(readFileSync(join(artifact.plugin, manifest.hooks), "utf8"));
    expect(Object.keys(hooks.hooks).sort()).toEqual([...EVENTS].sort());
    const mcp = JSON.parse(readFileSync(join(artifact.plugin, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.zinn).toMatchObject({ type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/launcher.mjs"], cwd: "${PLUGIN_ROOT}" });
    const html = readFileSync(join(artifact.plugin, "widget.html"), "utf8");
    expect(html).not.toMatch(/(?:src|href)=["'](?:https?:|\/_astro|\/fonts)/);
    const script = html.match(/<script type="module">([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    new Bun.Transpiler({ loader: "js", target: "browser" }).transformSync(script!);
    const notices = readFileSync(join(artifact.plugin, "THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).toContain("@modelcontextprotocol/sdk");
    expect(notices).toContain("@modelcontextprotocol/ext-apps");
    expect(notices).toContain("zod");
    for (const file of ["server.mjs", "launcher.mjs", "hook.mjs", "widget.html", ".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"]) {
        const text = readFileSync(join(artifact.plugin, file), "utf8");
        expect(text).not.toContain("/Users/");
        expect(text).not.toContain("research/");
        expect(text).not.toContain("Bun.");
        expect(text).not.toContain("bun:");
    }
});
test("relocated Node artifact reads selected tasks and isolates each chat", async () => {
    const initial = fingerprint();
    const client = await connect();
    const before = fingerprint();
    expect(before.find(([file]) => file === "zinn.sqlite")).toEqual(initial.find(([file]) => file === "zinn.sqlite"));
    try {
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name).sort()).toEqual(["inspect_task", "move_task", "recent_tasks", "task_columns"]);
        for (const tool of tools.tools) {
            expect((tool._meta?.ui as any).visibility).toEqual(["app"]);
        }
        expect(tools.tools.find(tool => tool.name === "inspect_task")?.annotations?.readOnlyHint).toBe(true);
        expect(tools.tools.find(tool => tool.name === "task_columns")?.annotations?.readOnlyHint).toBe(true);
        expect(tools.tools.find(tool => tool.name === "move_task")?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
        const read = async (key: string) => (await client.callTool({ name: "inspect_task", arguments: { key } })).structuredContent as any;
        expect(await read("app-1")).toMatchObject({ kind: "ready", task: { key: "APP-1", description: "First line\n<script>literal text</script>" } });
        expect((await read("APP-1")).task.comments[0].text).toBe("Literal <img src=x> comment");
        expect((await read("APP-1")).task.relations).toContainEqual(expect.objectContaining({ type: "related", direction: null, task: expect.objectContaining({ key: "APP-3", title: "Related fixture" }) }));
        expect(await read("APP-2")).toMatchObject({ kind: "ready", task: { status: "Archived" } });
        expect((await read("APP-999")).kind).toBe("missing");
        expect((await read("invalid")).kind).toBe("invalid");
        const recent = async (metadata?: Record<string, unknown>) => (await client.callTool({ name: "recent_tasks", arguments: {}, _meta: metadata })).structuredContent as any;
        expect((await recent({ thread_id: "chat-one" })).references.map((item: any) => item.key)).toEqual(["APP-1"]);
        expect((await recent({ threadId: "chat-two" })).references.map((item: any) => item.key)).toEqual(["APP-2"]);
        expect((await recent()).kind).toBe("absent_metadata");
        expect((await recent({ thread_id: "chat-one", threadId: "chat-two" })).kind).toBe("conflicting_metadata");
        const page = await client.readResource({ uri: resource });
        expect(page.contents[0]!.mimeType).toBe("text/html;profile=mcp-app");
        expect((page.contents[0] as any).text).toBe(readFileSync(join(artifact.plugin, "widget.html"), "utf8"));
        expect(fingerprint()).toEqual(before);
        context.cli(["task", "edit", "APP-1", "--title", "Fresh title"]);
        expect((await read("APP-1")).task.title).toBe("Fresh title");
    }
    finally {
        await client.close();
    }
    const restarted = await connect();
    try {
        expect((await restarted.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent).toMatchObject({ kind: "ready", task: { title: "Fresh title" } });
    }
    finally {
        await restarted.close();
    }
}, 30000);

test("panel lists the selected task's columns and moves through the configured CLI as a human", async () => {
    context.cli(["project", "column", "create", "--category", "todo", "APP", "--", "-Needs review"]);
    context.cli(["project", "create", "ALT"]);
    context.cli(["project", "column", "create", "--category", "todo", "ALT", "--", "-Alpha"]);
    context.cli(["task", "create", "ALT", "--title", "Other project task"]);
    context.cli(["task", "create", "APP", "--title", "Move fixture", "--description", "Keep this description"]);
    context.cli(["task", "create", "APP", "--title", "Earlier destination task"]);
    context.cli(["task", "move", "--", "APP-5", "-Needs review"]);

    const wrongStore = join(context.directory, "inherited-wrong-store");
    const log = join(context.directory, "human-action-env.jsonl");
    const wrapper = join(context.directory, "logging-cli.mjs");
    writeFileSync(wrapper, `import {appendFileSync} from 'node:fs';
const cliPath = ${JSON.stringify(cliPath)};
const args = process.argv.slice(2);
if (!(args.length === 1 && args[0] === '--version')) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, actor: ${JSON.stringify(actorEnvironmentNames())}.map(name => [name, process.env[name] ?? null]), custom: process.env.ZINN_TEST_CUSTOM}) + '\\n');
}
process.argv.splice(1, 1, cliPath);
await import(${JSON.stringify(pathToFileURL(cliPath).href)});
`);
    const config = join(context.directory, "human-actions-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, cli: ["node", wrapper] }));
    const inheritedActorEnvironment = Object.fromEntries(
        actorEnvironmentNames().map(name => [name, `synthetic-${name.toLowerCase()}`]),
    );
    const client = await connect(config, {
        ...inheritedActorEnvironment,
        ZINN_DIR: wrongStore,
        ZINN_TEST_CUSTOM: "preserved-custom-value",
    });
    try {
        const columns = (await client.callTool({ name: "task_columns", arguments: { key: "ALT-1" } })).structuredContent as any;
        expect(columns.kind).toBe("ready");
        expect(columns.store).toBe(context.settings.store);
        expect(columns.key).toBe("ALT-1");
        expect(columns.columns.map((column: any) => column.name)).toContain("-Alpha");
        expect(columns.columns.map((column: any) => column.name)).not.toContain("-Needs review");
        expect((await client.callTool({ name: "task_columns", arguments: { key: "ALT-999" } })).structuredContent).toMatchObject({ kind: "error", key: "ALT-999" });
        expect((await client.callTool({ name: "task_columns", arguments: { key: "invalid" } })).structuredContent).toMatchObject({ kind: "error", key: "INVALID" });

        const moved = (await client.callTool({ name: "move_task", arguments: { key: "APP-4", column: "-Needs review" } })).structuredContent as any;
        expect(moved).toMatchObject({ kind: "ready", store: context.settings.store, key: "APP-4", changed: true, task: { key: "APP-4", column: "-Needs review", changed: true } });
        const afterMove = context.cli(["activity", "list", "--task", "APP-4"]);
        const moveEvents = afterMove.filter((event: any) => event.action === "move");
        expect(moveEvents).toHaveLength(1);
        expect(moveEvents[0]).toMatchObject({
            actor_kind: "human",
            actor_session_id: null,
            actor_thread_id: null,
            actor_agent: null,
            actor_model: null,
            actor_effort: null,
            changes: { column: [{ name: expect.any(String) }, { name: "-Needs review" }] },
        });
        expect(moveEvents[0].actor_client).toEndWith(` ${CODEX_CLIENT}`);
        expect(moveEvents[0].actor_client).not.toContain("synthetic-zinn_client");
        expect((await client.callTool({ name: "inspect_task", arguments: { key: "APP-4" } })).structuredContent).toMatchObject({
            kind: "ready",
            task: { key: "APP-4", title: "Move fixture", description: "Keep this description", column: "-Needs review" },
        });
        expect(context.cli(["task", "list", "APP", "--column=-Needs review"]).map((task: any) => task.key)).toEqual(["APP-5", "APP-4"]);
        const unchanged = (await client.callTool({ name: "move_task", arguments: { key: "APP-4", column: "-Needs review" } })).structuredContent as any;
        expect(unchanged).toMatchObject({ kind: "ready", changed: false, task: { changed: false } });
        expect(context.cli(["activity", "list", "--task", "APP-4"]).filter((event: any) => event.action === "move")).toHaveLength(1);
        expect((await client.callTool({ name: "move_task", arguments: { key: "APP-4", column: "Unavailable" } })).structuredContent).toMatchObject({ kind: "error", key: "APP-4" });
        expect(context.cli(["activity", "list", "--task", "APP-4"]).filter((event: any) => event.action === "move")).toHaveLength(1);
        expect((await client.callTool({ name: "move_task", arguments: { key: "APP-2", column: "Done" } })).structuredContent).toMatchObject({ kind: "error", key: "APP-2" });
        expect((await client.callTool({ name: "move_task", arguments: { key: "APP-999", column: "Done" } })).structuredContent).toMatchObject({ kind: "error", key: "APP-999" });
        expect((await client.callTool({ name: "move_task", arguments: { key: "invalid", column: "Done" } })).structuredContent).toMatchObject({ kind: "error", key: "INVALID" });

        const childCalls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
        const moveCall = childCalls.find((call: any) => call.args[0] === "task" && call.args[1] === "move");
        expect(moveCall.args).toEqual(["task", "move", "--json", "--", "APP-4", "-Needs review"]);
        expect(moveCall.custom).toBe("preserved-custom-value");
        expect(moveCall.actor).toEqual(
            actorEnvironmentNames().map(name => [name, name === "ZINN_CLIENT" ? CODEX_CLIENT : null]),
        );
        expect(existsSync(wrongStore)).toBe(false);
    } finally {
        await client.close();
    }
});
test("relocated Node artifact reports an absent store without creating it", async () => {
    const absent = join(context.directory, "absent-store");
    const config = join(context.directory, "absent-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, store: absent }));
    const client = await connect(config);
    try {
        expect((await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent).toMatchObject({ kind: "error" });
        expect(existsSync(absent)).toBe(false);
    }
    finally {
        await client.close();
    }
}, 30000);

test("relocated panel permits an ordinary upgrade and stays responsive during a slow read", async () => {
    const control = join(context.directory, "control older store");
    const store = join(context.directory, "panel older store");
    seedOlderStore(control);
    seedOlderStore(store);
    const before = inspectStore(store);
    expect(before.snapshot.version).toBe(1);
    const standalone = context.cli(["task", "view", "APP-1"], control);
    const started = join(context.directory, "slow-read-started");
    const script = join(context.directory, "slow-cli.mjs");
    const delayMs = 1800;
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
if (process.argv[2] === '--version') { console.log('0.43.0'); }
else { writeFileSync(${JSON.stringify(started)}, 'started'); setTimeout(() => import(${JSON.stringify(pathToFileURL(cliPath).href)}), ${delayMs}); }`);
    const config = join(context.directory, "slow-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, store, cli: ["node", script] }));
    const client = await connect(config);
    try {
        const began = performance.now();
        const pending = client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } });
        await waitFor(() => existsSync(started));
        const responsive = await Promise.race([
            client.listTools().then(() => true),
            Bun.sleep(500).then(() => false),
        ]);
        expect(responsive).toBe(true);
        const result = (await pending).structuredContent as any;
        expect(result).toMatchObject({ kind: "ready", task: standalone });
        expect(performance.now() - began).toBeGreaterThan(delayMs);
        expect(inspectStore(store)).toEqual(inspectStore(control));
        expect(readdirSync(join(store, "backups"))).toHaveLength(1);
        expect(readdirSync(join(control, "backups"))).toHaveLength(1);
    } finally {
        await client.close();
    }
}, 30000);

test("relocated Node artifact reads a compatible newer schema like the ordinary CLI", async () => {
    const store = join(context.directory, "newer-schema-store");
    mkdirSync(store);
    context.cli(["project", "create", "APP"], store);
    context.cli(["task", "create", "APP", "--title", "Compatible newer fixture"], store);
    const supportedVersion = latestVersion(MIGRATIONS);
    const databasePath = join(store, "data/zinn.sqlite");
    const db = openDatabase(databasePath);
    try {
        db.exec(`PRAGMA user_version = ${supportedVersion + 1}`);
    } finally {
        db.close();
    }
    const before = inspectStore(store);
    const ordinary = context.cli(["task", "view", "APP-1"], store);
    const config = join(context.directory, "newer-schema-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, store }));
    const client = await connect(config);
    try {
        const result = (await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent as any;
        expect(result).toMatchObject({ kind: "ready", task: ordinary });
        expect(inspectStore(store)).toEqual(before);
        expect(existsSync(join(store, "backups"))).toBe(false);
    } finally {
        await client.close();
    }
}, 30000);

test("relocated Node artifact reports an incompatible newer schema without fallback or writes", async () => {
    const store = join(context.directory, "incompatible-newer-schema-store");
    mkdirSync(store);
    context.cli(["project", "create", "APP"], store);
    context.cli(["task", "create", "APP", "--title", "Incompatible newer fixture"], store);
    const supportedVersion = latestVersion(MIGRATIONS);
    const databasePath = join(store, "data/zinn.sqlite");
    const db = openDatabase(databasePath);
    try {
        db.exec(`PRAGMA user_version = ${supportedVersion + 1}`);
        db.exec("DROP TABLE task");
    } finally {
        db.close();
    }
    const before = inspectStore(store);
    const calls = join(context.directory, "incompatible-newer-schema-calls.jsonl");
    const cli = join(context.directory, "incompatible-newer-schema-cli.mjs");
    writeFileSync(cli, `import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
await import(${JSON.stringify(pathToFileURL(cliPath).href)});`);
    const config = join(context.directory, "incompatible-newer-schema-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, store, cli: ["node", cli] }));
    const client = await connect(config);
    try {
        const result = (await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent as any;
        expect(result.kind).toBe("error");
        expect(readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
            ["--version"], ["task", "view", "APP-1", "--json"],
        ]);
        expect(inspectStore(store)).toEqual(before);
        expect(existsSync(join(store, "backups"))).toBe(false);
    } finally {
        await client.close();
    }
}, 30000);

test("relocated Node artifact and ordinary CLI agree on unmarked-store acknowledgment", async () => {
    const store = join(context.directory, "unmarked-store");
    seedOlderStore(store);
    const db = openDatabase(join(store, "data/zinn.sqlite"));
    try {
        db.exec("PRAGMA user_version = 0");
    } finally {
        db.close();
    }
    const before = inspectStore(store);
    const ordinaryRefusal = Bun.spawnSync(["node", cliPath, "task", "view", "APP-1", "--json"], { env: { ...context.env, ZINN_DIR: store } });
    expect(ordinaryRefusal.exitCode).not.toBe(0);
    expect(inspectStore(store)).toEqual(before);

    const refusalConfig = join(context.directory, "unmarked-refusal-config.json");
    writeFileSync(refusalConfig, JSON.stringify({ ...context.settings, store }));
    const refusedClient = await connect(refusalConfig);
    try {
        const result = (await refusedClient.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent as any;
        expect(result.kind).toBe("error");
    } finally {
        await refusedClient.close();
    }
    expect(inspectStore(store)).toEqual(before);

    const acknowledged = Bun.spawnSync(["node", cliPath, "--allow-legacy-read", "task", "view", "APP-1", "--json"], { env: { ...context.env, ZINN_DIR: store } });
    expect(acknowledged.exitCode).toBe(0);
    const ordinaryTask = JSON.parse(acknowledged.stdout.toString());
    const acknowledgedCli = join(context.directory, "unmarked-acknowledged-cli.mjs");
    writeFileSync(acknowledgedCli, `import {pathToFileURL} from 'node:url';
const args = process.argv.slice(2);
if (args[0] !== '--version') { process.argv.splice(2, 0, '--allow-legacy-read'); }
await import(${JSON.stringify(pathToFileURL(cliPath).href)});`);
    const acknowledgedConfig = join(context.directory, "unmarked-acknowledged-config.json");
    writeFileSync(acknowledgedConfig, JSON.stringify({ ...context.settings, store, cli: ["node", acknowledgedCli] }));
    const acknowledgedClient = await connect(acknowledgedConfig);
    try {
        const result = (await acknowledgedClient.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent as any;
        expect(result).toMatchObject({ kind: "ready", task: ordinaryTask });
    } finally {
        await acknowledgedClient.close();
    }
    expect(inspectStore(store)).toEqual(before);
    expect(existsSync(join(store, "backups"))).toBe(false);
}, 30000);

test("relocated panel reads the last commit while a writer lock is held and sees the next WAL commit", async () => {
    const store = join(context.directory, "wal-store");
    mkdirSync(store);
    context.cli(["project", "create", "WAL"], store);
    context.cli(["task", "create", "WAL", "--title", "Before concurrent edit"], store);
    const databasePath = join(store, "data/zinn.sqlite");
    const normalSidecarNames = readdirSync(join(store, "data"));
    expect(normalSidecarNames).not.toContain("zinn.sqlite-wal");
    expect(inspectStore(store).snapshot.version).toBe(latestVersion(MIGRATIONS));

    const config = join(context.directory, "wal-panel-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, store }));
    const holder = openDatabase(databasePath);
    try {
        holder.exec("PRAGMA journal_mode = WAL");
        holder.exec("PRAGMA wal_autocheckpoint = 0");
        const taskId = holder.query<{ id: string }>("SELECT id FROM task WHERE number = 1").get()!.id;
        holder.exec("BEGIN IMMEDIATE");
        holder.query("UPDATE task SET title = ? WHERE id = ?").run("Uncommitted title", taskId);
        const client = await connect(config);
        try {
            const read = (await client.callTool({ name: "inspect_task", arguments: { key: "WAL-1" } })).structuredContent as any;
            expect(read).toMatchObject({ kind: "ready", task: { key: "WAL-1", title: "Before concurrent edit" } });
            expect(existsSync(`${databasePath}-wal`)).toBe(true);
        } finally {
            await client.close();
        }
        holder.exec("ROLLBACK");

        const edit = context.cli(["task", "edit", "WAL-1", "--title", "Committed after panel read"], store);
        expect(edit.title).toBe("Committed after panel read");
        expect(existsSync(`${databasePath}-wal`)).toBe(true);

        const walPanel = await connect(config);
        try {
            expect((await walPanel.callTool({ name: "inspect_task", arguments: { key: "WAL-1" } })).structuredContent).toMatchObject({
                kind: "ready",
                task: { title: "Committed after panel read" },
            });
        } finally {
            await walPanel.close();
        }
        expect(context.cli(["task", "view", "WAL-1"], store).title).toBe("Committed after panel read");

        const mainFileCopy = join(context.directory, "wal-store-main-only.sqlite");
        copyFileSync(databasePath, mainFileCopy);
        const mainOnly = openDatabase(mainFileCopy);
        try {
            expect(mainOnly.query<{ title: string }>("SELECT title FROM task WHERE id = ?").get(taskId)).toEqual({ title: "Before concurrent edit" });
        } finally {
            mainOnly.close();
        }
        expect(holder.query<{ title: string }>("SELECT title FROM task WHERE id = ?").get(taskId)).toEqual({ title: "Committed after panel read" });
        expect(inspectStore(store).snapshot.version).toBe(latestVersion(MIGRATIONS));
        const events = context.cli(["activity", "list", "--task", "WAL-1"], store);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ action: "edit", changes: { title: ["Before concurrent edit", "Committed after panel read"] } });
    } finally {
        if (holder.inTransaction) {
            holder.exec("ROLLBACK");
        }
        holder.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        holder.close();
    }

    const restarted = await connect(config);
    try {
        expect((await restarted.callTool({ name: "inspect_task", arguments: { key: "WAL-1" } })).structuredContent).toMatchObject({ kind: "ready", task: { title: "Committed after panel read" } });
    } finally {
        await restarted.close();
    }
}, 30000);

test("structured task and project misses avoid a second CLI read", async () => {
    const cases = [
        { code: "not_found", entity: "task", kind: "missing" },
        { code: "not_found", entity: "project", kind: "missing" },
        { code: "not_found", entity: "database", kind: "error" },
        { code: "storage", entity: "database", kind: "error" },
        { code: "conflict", entity: "database", kind: "error" },
        { code: "malformed", entity: "database", kind: "error" },
    ];
    for (const [index, value] of cases.entries()) {
        const log = join(context.directory, `failure-${index}.jsonl`);
        const script = join(context.directory, `failure-${index}.mjs`);
        const error = JSON.stringify({ error: { code: value.code, details: { entity: value.entity }, message: "Fixture failure" } });
        writeFileSync(script, `import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('0.43.0'); }
else { process.stderr.write(${JSON.stringify(value.code === "malformed" ? "invalid json" : error)}); process.exitCode = 1; }`);
        const config = join(context.directory, `failure-${index}.json`);
        writeFileSync(config, JSON.stringify({ ...context.settings, cli: ["node", script] }));
        const client = await connect(config);
        try {
            expect((await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent).toMatchObject({ kind: value.kind });
            expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
                ["--version"], ["task", "view", "APP-1", "--json"],
            ]);
        } finally {
            await client.close();
        }
    }
});

test("panel cancellation and shutdown stop the owned CLI even when SIGTERM is ignored", async () => {
    const marker = join(context.directory, "owned-child.json");
    const script = join(context.directory, "pending-cli.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
if (process.argv[2] === '--version') { console.log('0.43.0'); }
else { process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000); }`);
    const config = join(context.directory, "pending-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, cli: ["node", script] }));
    const alive = (pid: number) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const client = await connect(config);
    try {
        const cancellation = new AbortController();
        const pending = client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } }, undefined, { signal: cancellation.signal }).catch(() => undefined);
        await waitFor(() => existsSync(marker));
        const first = JSON.parse(readFileSync(marker, "utf8")).pid;
        cancellation.abort();
        await pending;
        await waitFor(() => !alive(first));
        expect((await client.listTools()).tools.length).toBe(4);
        rmSync(marker);
        const closingRead = client.callTool({ name: "inspect_task", arguments: { key: "APP-2" } }).catch(() => undefined);
        await waitFor(() => existsSync(marker));
        const second = JSON.parse(readFileSync(marker, "utf8")).pid;
        await client.close();
        await closingRead;
        await waitFor(() => !alive(second));
    } finally {
        await client.close();
    }
});

test("supported CLI owns missing and empty database failures without initializing them", async () => {
    for (const empty of [false, true]) {
        const store = join(context.directory, empty ? "empty-database" : "missing-database");
        mkdirSync(join(store, "data"), { recursive: true });
        if (empty) {
            writeFileSync(join(store, "data/zinn.sqlite"), "");
        }
        const config = join(context.directory, empty ? "empty-config.json" : "missing-config.json");
        writeFileSync(config, JSON.stringify({ ...context.settings, store }));
        const client = await connect(config);
        try {
            expect((await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent).toMatchObject({ kind: "error" });
            expect(existsSync(join(store, "data/zinn.sqlite"))).toBe(empty);
            if (empty) {
                expect(readFileSync(join(store, "data/zinn.sqlite")).byteLength).toBe(0);
            }
            expect(existsSync(join(store, "backups"))).toBe(false);
        } finally {
            await client.close();
        }
    }
});

test("panel enforces CLI output bounds and reaps the child", async () => {
    const marker = join(context.directory, "oversized-child.json");
    const script = join(context.directory, "oversized-cli.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs';
if (process.argv[2] === '--version') { console.log('0.43.0'); }
else { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid})); process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)); setInterval(() => {}, 1000); }`);
    const config = join(context.directory, "oversized-config.json");
    writeFileSync(config, JSON.stringify({ ...context.settings, cli: ["node", script] }));
    const client = await connect(config);
    try {
        expect((await client.callTool({ name: "inspect_task", arguments: { key: "APP-1" } })).structuredContent).toMatchObject({ kind: "error" });
        const pid = JSON.parse(readFileSync(marker, "utf8")).pid;
        expect(() => process.kill(pid, 0)).toThrow();
    } finally {
        await client.close();
    }
});
