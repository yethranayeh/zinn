import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { packageIntegration } from "../package";
import { INSPECTOR_VERSION } from "../src/runtime";
import { EVENTS } from "../src/hooks/observe";
import { persist, type Observation } from "../src/shared/feed";
import { cliPath, fixture, inspectStore, seedOlderStore, waitFor } from "./helpers";
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
                    expect(inspectStore(store)).toEqual(ordinaryState);
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
        expect(tools.tools.map(tool => tool.name).sort()).toEqual(["inspect_task", "recent_tasks"]);
        for (const tool of tools.tools) {
            expect(tool.annotations?.readOnlyHint).toBe(true);
            expect((tool._meta?.ui as any).visibility).toEqual(["app"]);
        }
        const read = async (key: string) => (await client.callTool({ name: "inspect_task", arguments: { key } })).structuredContent as any;
        expect(await read("app-1")).toMatchObject({ kind: "ready", task: { key: "APP-1", description: "First line\n<script>literal text</script>" } });
        expect((await read("APP-1")).task.comments[0].text).toBe("Literal <img src=x> comment");
        expect((await read("APP-1")).task.relations).toContainEqual(expect.objectContaining({ type: "related", task: expect.objectContaining({ key: "APP-3", title: "Related fixture" }) }));
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
        expect((await client.listTools()).tools.length).toBe(2);
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
