import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { packageIntegration } from "../package";
import { backendArguments, INSPECTOR_VERSION } from "../src/runtime";
import { persist, type Observation } from "../src/shared/feed";
import { fixture } from "./helpers";
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
context.cli(["task", "comment", "create", "APP-1", "--text", "Literal <img src=x> comment"]);
for (const [session, key] of [["chat-one", "APP-1"], ["chat-two", "APP-2"]]) {
    persist(context.settings.dataDirectory, { version: 1, session, ts: new Date().toISOString(), references: [{ key, source: "argv", store: context.settings.store }], replyFailedStore: null } as Observation);
}
const resource = `ui://zinn/inspector-${INSPECTOR_VERSION}.html`;
function fingerprint() {
    const directory = join(context.settings.store, "data");
    return readdirSync(directory).sort().map(file => [file, createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")]);
}
async function connect(config = context.config) {
    const client = new Client({ name: "zinn-artifact-check", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: "node", args: [join(artifact.plugin, "launcher.mjs")], cwd: context.directory, env: { ...process.env as Record<string, string>, ZINN_CODEX_CONFIG: config } });
    await client.connect(transport);
    return client;
}
test("artifact contains only portable bundled assets and dependency notices", () => {
    expect(createHash("sha256").update(readFileSync(packaged.archive)).digest("hex")).toBe(packaged.sha256);
    const manifest = JSON.parse(readFileSync(join(artifact.plugin, "plugin.json"), "utf8"));
    expect(manifest.name).toBe("zinn");
    expect(manifest.version).toBe(INSPECTOR_VERSION);
    const mcp = JSON.parse(readFileSync(join(artifact.plugin, "mcp.json"), "utf8"));
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
    for (const file of ["server.mjs", "launcher.mjs", "hook.mjs", "widget.html", "plugin.json", "mcp.json"]) {
        const text = readFileSync(join(artifact.plugin, file), "utf8");
        expect(text).not.toContain("/Users/");
        expect(text).not.toContain("research/");
        expect(text).not.toContain("Bun.");
        expect(text).not.toContain("bun:");
    }
});
test.skipIf(process.platform !== "darwin")("relocated Node artifact reads selected tasks and isolates each chat under the OS sandbox", async () => {
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
        const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", ...backendArguments("node", context.settings.cli[1]!), "task", "create", "APP", "--title", "Forbidden mutation", "--json"], { env: context.env });
        expect(denied.exitCode).not.toBe(0);
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
test.skipIf(process.platform !== "darwin")("same sandbox denies fixture writes and network and refuses absent stores", async () => {
    const before = fingerprint();
    const sentinel = join(context.directory, "must-not-write");
    const script = join(context.directory, "write.mjs");
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'forbidden');`);
    const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", ...backendArguments("node", script)], { env: context.env });
    expect(denied.exitCode).not.toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    const network = join(context.directory, "network.mjs");
    writeFileSync(network, "import net from 'node:net'; const server=net.createServer(); server.on('error',()=>process.exit(12)); server.listen(0,'127.0.0.1',()=>process.exit(0));");
    expect(Bun.spawnSync(["/usr/bin/sandbox-exec", ...backendArguments("node", network)], { env: context.env, timeout: 3000 }).exitCode).not.toBe(0);
    expect(fingerprint()).toEqual(before);
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
