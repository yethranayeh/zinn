import type { installConsumer } from "./package-fixture.ts";

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hostVersion, packInspector, run } from "./package-fixture.ts";

const START_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
async function until(predicate: () => boolean, failure: () => string) {
  const started = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - started < START_TIMEOUT_MS, failure());
    await Bun.sleep(POLL_MS);
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Puts a `zinn` wrapper first on PATH that records each CLI call before running it. */
function recordCalls(consumer: ReturnType<typeof installConsumer>, directory: string): string {
  const calls = join(directory, "zinn-calls.log");
  writeFileSync(calls, "");
  const wrapper = join(directory, "bin", "zinn");
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(
    wrapper,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(calls)}\nexec ${shellQuote(process.execPath)} ${shellQuote(consumer.releasedCLI)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return calls;
}

/** Loads an extracted package through the host's own TUI loader in an isolated PTY. */
export async function verifyHost(fixture: ReturnType<typeof packInspector>, consumer: ReturnType<typeof installConsumer>) {
  const updated = packInspector(true);
  const app = join(fixture.directory, "app");
  mkdirSync(app);
  const configDirectory = join(fixture.env.XDG_CONFIG_HOME!, "opencode");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify({
    enabled_providers: [],
    share: "disabled",
    plugins: [{ package: fixture.extracted, options: { rows: 2, current: "glyph" } }],
  }));
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
    const waitForPlugin = async (id: string) => {
      const started = Date.now();
      while (true) {
        const response = await request("/api/plugin");
        const list = Array.isArray(response) ? response : response.data;
        const found = list.find((plugin: { id?: string }) => plugin.id === id);
        if (found) return found;
        assert.ok(Date.now() - started < START_TIMEOUT_MS, `Server did not list plugin ${id}`);
        await Bun.sleep(POLL_MS);
      }
    };
    const original = (await request("/api/session", { title: "Inspector fixture template", location: { directory: app } })).data;
    const root = { ...original, id: `${original.id}_root`, title: "Inspector fixture conversation" };
    const child = { ...original, id: `${original.id}_child`, parentID: root.id, title: "Inspector fixture child" };
    const message = { id: "msg_inspector_fixture", type: "user", time: { created: Date.now() }, text: "Inspect PKG-1, PKG-2, PKG-3, PKG-4 and PKG-999" };
    await request("/api/experimental/session/import", { info: root, messages: [message], location: { directory: app } });
    await request("/api/experimental/session/import", { info: child, messages: [], location: { directory: app } });
    run([process.execPath, consumer.releasedCLI, "task", "create", "PKG", "--title", "Archived reference", "--json"], app, env);
    run([process.execPath, consumer.releasedCLI, "task", "archive", "PKG-4"], app, env);
    run([process.execPath, consumer.releasedCLI, "task", "comment", "create", "PKG-1", "--text", "Child activity"], app, { ...env, OPENCODE_SESSION_ID: child.id });
    run([process.execPath, consumer.releasedCLI, "task", "comment", "create", "PKG-3", "--text", "Root activity"], app, { ...env, ZINN_SESSION_ID: root.id });
    run([process.execPath, consumer.releasedCLI, "task", "move", "PKG-3", "Done"], app, env);
    run([process.execPath, consumer.releasedCLI, "task", "comment", "create", "PKG-4", "--text", "Archived child activity"], app, { ...env, OPENCODE_SESSION_ID: child.id });
    const log = join(fixture.directory, "inspector.log");
    const calls = recordCalls(consumer, fixture.directory);
    const config = join(configDirectory, "cli.json");
    const serverConfig = join(configDirectory, "opencode.json");
    const frames: string[] = [];
    const launch = async (plugins: unknown[], mode: "install" | "update" | "remove") => {
      writeFileSync(config, JSON.stringify({ plugins }));
      writeFileSync(serverConfig, JSON.stringify({ enabled_providers: [], share: "disabled", plugins }));
      writeFileSync(log, "");
      writeFileSync(calls, "");
      let output = "";
      const tui = Bun.spawn([consumer.host, "--server", base, "--session", root.id, app], {
        cwd: app, env: { ...env, OPENCODE_SERVER_PASSWORD: password, ZINN_INSPECTOR_LOG: log, TERM: "xterm-256color" },
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
          await until(
            () => ["3 tasks", "PKG-1", "PKG-2", "PKG-3"].every((text) => output.includes(text)),
            () => `Sidebar rows did not render: ${output.slice(-2000)}`,
          );
          await until(() => output.includes("⧗") && readFileSync(log, "utf8").includes("activity probes settled"), () => "Family activity glyph did not render");
          const settledLine = readFileSync(log, "utf8").split("\n").find((line) => line.includes("activity probes settled"))!;
          const matches = JSON.parse(settledLine.slice(settledLine.indexOf("{"))).matches as string[];
          assert.ok(matches.includes("PKG-1") && matches.includes("PKG-3") && matches.includes("PKG-4"), "Root and child task activity was not recognized");
          assert.ok(!matches.includes("PKG-2"), "Unrelated task received a conversation mark");
          await until(() => readFileSync(log, "utf8").includes(" scan "), () => "The scan was not logged");
          const scanLine = readFileSync(log, "utf8").split("\n").filter((line) => line.includes(" scan ")).at(-1)!;
          const scan = JSON.parse(scanLine.slice(scanLine.indexOf("{")));
          assert.equal(scan.known, 4, "The archived reference was not loaded as a known task");
          assert.deepEqual(scan.unknownKeys, ["PKG-999"], "A genuinely missing key was not kept unknown");
          await until(() => output.includes("Archived reference"), () => `The archived row did not render: ${output.slice(-2000)}`);
          const activityCalls = readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith("activity list"));
          assert.ok(activityCalls.length > 0, "The mount made no activity read");
          assert.equal(new Set(activityCalls).size, activityCalls.length, `The mount repeated an activity read: ${activityCalls.join(" | ")}`);
          tui.terminal!.write("/zinn");
          await Bun.sleep(250);
          tui.terminal!.write("\r");
          await until(() => readFileSync(log, "utf8").includes("picker opened"), () => `Task picker did not open: ${output.slice(-1000)}`);
          const boardPicker = readFileSync(log, "utf8").split("\n").find((line) => line.includes("picker opened"))!;
          assert.equal(JSON.parse(boardPicker.slice(boardPicker.indexOf("{"))).options, 3, "Board picker included archived tasks");
          tui.terminal!.write("\r");
          await until(() => readFileSync(log, "utf8").includes('"kind":"ready"'), () => `Task detail did not settle: ${readFileSync(log, "utf8")}`);
          await until(
            () => readFileSync(log, "utf8").includes('"excerpt":true'),
            () => `Task detail did not show the mention excerpt: ${readFileSync(log, "utf8")}`,
          );
        }
        frames.push(output);
      } finally {
        tui.kill("SIGTERM");
        await tui.exited;
        tui.terminal?.close();
      }
    };
    await launch([{ package: fixture.extracted, options: { rows: 2, current: "glyph" } }], "install");
    const listed = await waitForPlugin("zinn");
    assert.equal(listed.state.status, "active");
    assert.deepEqual(listed.features, { server: true, tui: true, gui: true });
    const guiResponse = await request(`/api/plugin/gui?id=zinn&directory=${encodeURIComponent(app)}`);
    const bundle = guiResponse.data ?? guiResponse;
    assert.ok(bundle.code.includes("zinn.board"), "GUI bundle did not contain the board IPC");
    assert.deepEqual(bundle.options, { rows: 2, current: "glyph" });
    await launch([{ package: updated.extracted, options: { rows: 2, current: "glyph" } }], "update");
    await launch([], "remove");
    return { version: hostVersion, frames };
  } finally {
    server.kill("SIGTERM");
    await server.exited;
    await Promise.all(drains);
    rmSync(updated.directory, { recursive: true, force: true });
  }
}
