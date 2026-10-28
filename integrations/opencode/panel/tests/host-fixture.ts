import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packInspector, run } from "./package-fixture.ts";
import type { installConsumer } from "./package-fixture.ts";

const START_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
async function until(predicate: () => boolean, failure: () => string) {
  const started = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - started < START_TIMEOUT_MS, failure());
    await Bun.sleep(POLL_MS);
  }
}

/** Loads an extracted package through the host's own TUI loader in an isolated PTY. */
export async function verifyHost(fixture: ReturnType<typeof packInspector>, consumer: ReturnType<typeof installConsumer>) {
  const updated = packInspector(true);
  const app = join(fixture.directory, "app");
  mkdirSync(app);
  const configDirectory = join(fixture.env.XDG_CONFIG_HOME!, "opencode");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify({ enabled_providers: [], share: "disabled" }));
  const env = { ...consumer.env, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1" };
  let serverOutput = "";
  const server = Bun.spawn([consumer.host, "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: app, env, stdout: "pipe", stderr: "pipe" });
  const drain = async (stream: ReadableStream<Uint8Array>, receive: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      receive(decoder.decode(bytes, { stream: true }));
    }
  };
  const drains = [drain(server.stdout, (text) => { serverOutput += text; }), drain(server.stderr, (text) => { serverOutput += text; })];
  try {
    await until(() => /server listening on (http:\/\/[^\s]+)/.test(serverOutput) && /server password (\S+)/.test(serverOutput), () => "Isolated OpenCode server did not start");
    const base = /server listening on (http:\/\/[^\s]+)/.exec(serverOutput)![1]!;
    const password = /server password (\S+)/.exec(serverOutput)![1]!;
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(new URL(path, base), { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Basic ${btoa(`opencode:${password}`)}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      assert.ok(response.ok, `${path}: ${response.status} ${text}`);
      return text === "" ? undefined : JSON.parse(text);
    };
    const original = (await request("/api/session", { title: "Inspector fixture template", location: { directory: app } })).data;
    const root = { ...original, id: `${original.id}_root`, title: "Inspector fixture conversation" };
    const child = { ...original, id: `${original.id}_child`, parentID: root.id, title: "Inspector fixture child" };
    const message = { id: "msg_inspector_fixture", type: "user", time: { created: Date.now() }, text: "Inspect PKG-1, PKG-2 and PKG-3" };
    await request("/api/experimental/session/import", { info: root, messages: [message], location: { directory: app } });
    await request("/api/experimental/session/import", { info: child, messages: [], location: { directory: app } });
    run([process.execPath, consumer.releasedCLI, "task", "comment", "create", "PKG-1", "--text", "Child activity"], app, { ...env, OPENCODE_SESSION_ID: child.id });
    run([process.execPath, consumer.releasedCLI, "task", "comment", "create", "PKG-3", "--text", "Root activity"], app, { ...env, ZINN_SESSION_ID: root.id });
    run([process.execPath, consumer.releasedCLI, "task", "move", "PKG-3", "Done"], app, env);
    const log = join(fixture.directory, "panel.log");
    const config = join(configDirectory, "cli.json");
    const frames: string[] = [];
    const launch = async (plugins: unknown[], mode: "install" | "update" | "remove") => {
      writeFileSync(config, JSON.stringify({ plugins }));
      writeFileSync(log, "");
      let output = "";
      const tui = Bun.spawn([consumer.host, "--server", base, "--session", root.id, app], {
        cwd: app, env: { ...env, OPENCODE_SERVER_PASSWORD: password, ZINN_PANEL_LOG: log, TERM: "xterm-256color" },
        terminal: { cols: 140, rows: 45, data(terminal, bytes) {
          const text = new TextDecoder().decode(bytes);
          output += text;
          if (text.includes("\x1b[c")) { terminal.write("\x1b[?1;2c"); }
          if (text.includes("\x1b[>c")) { terminal.write("\x1b[>0;0;0c"); }
          if (text.includes("\x1b[?u")) { terminal.write("\x1b[?0u"); }
        } },
      });
      try {
        if (mode === "remove") {
          await until(() => output.includes("Inspector fixture conversation"), () => `Removed-plugin TUI did not open: ${output.slice(-1000)}`);
          assert.equal(readFileSync(log, "utf8"), "", "Removed inspector still loaded");
        } else {
          await until(() => readFileSync(log, "utf8").includes("board keys loaded") && output.includes("ZINN"), () => `Inspector did not render: ${readFileSync(log, "utf8")} ${output.slice(-2000)}`);
          const diagnostics = readFileSync(log, "utf8");
          const expectedArtifact = mode === "update" ? "updated inspector artifact" : "plugin options";
          assert.ok(diagnostics.includes(expectedArtifact), "Expected package content did not load");
          assert.ok(diagnostics.includes('"rows":2'), "Package update lost configured options");
          assert.ok(diagnostics.includes('"zinn.chat"') && diagnostics.includes('"zinn.board"'), "Inspector commands were not registered");
          assert.ok(diagnostics.includes(root.id) && diagnostics.includes(child.id), "Host family did not include root and child");
          await until(() => output.includes("⧗") && readFileSync(log, "utf8").includes("activity probes settled"), () => "Family activity glyph did not render");
          const settledLine = readFileSync(log, "utf8").split("\n").find((line) => line.includes("activity probes settled"))!;
          const matches = JSON.parse(settledLine.slice(settledLine.indexOf("{"))).matches as string[];
          assert.ok(matches.includes("PKG-1") && matches.includes("PKG-3"), "Root and child task activity was not recognized");
          assert.ok(!matches.includes("PKG-2"), "Unrelated task received a conversation mark");
          tui.terminal!.write("/zinn");
          await Bun.sleep(250);
          tui.terminal!.write("\r");
          await until(() => readFileSync(log, "utf8").includes("picker opened"), () => `Task picker did not open: ${output.slice(-1000)}`);
          tui.terminal!.write("\r");
          await until(() => readFileSync(log, "utf8").includes('"kind":"ready"'), () => `Task detail did not settle: ${readFileSync(log, "utf8")}`);
        }
        frames.push(output);
      } finally {
        tui.kill("SIGTERM");
        await tui.exited;
        tui.terminal?.close();
      }
    };
    await launch([{ package: fixture.extracted, options: { rows: 2, current: "glyph" } }], "install");
    await launch([{ package: updated.extracted, options: { rows: 2, current: "glyph" } }], "update");
    await launch([], "remove");
    return { version: "2.2.0", frames };
  } finally {
    server.kill("SIGTERM");
    await server.exited;
    await Promise.all(drains);
    rmSync(updated.directory, { recursive: true, force: true });
  }
}
