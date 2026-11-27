import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rexDirectory = join(import.meta.dir, "..");
const harness = join(import.meta.dir, "action-harness.lua");
// Rex runs Lua 5.1. LuaJIT runs the same code.
const interpreters = ["lua5.1", "luajit"];
const interpreter = interpreters.map((name) => Bun.which(name)).find((path) => path !== null);

type Call = { name: string; args: Record<string, unknown> };
type Run = { ok: boolean; result: Record<string, unknown> | string; calls: Array<Call> };
type Scenario = {
  ctx?: Record<string, unknown>;
  args?: Record<string, unknown>;
  zinn?: Record<string, unknown>;
  picks?: Array<string | false>;
  blocks?: Array<Record<string, unknown>>;
  processes?: Record<string, unknown>;
};

const claudeSession = "d0dc5f20-b419-46ce-8b7f-6d0e94abadaa";
const codexSession = "01a20f5e-a0e1-73c1-b3bc-3fbc50cd73bc";
const openCodeSession = "ses_debb59b2bffe0IID5VUv4lCTzw";

function luaValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "nil";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `{ ${value.map(luaValue).join(", ")} }`;
  }
  const fields = Object.entries(value as Record<string, unknown>).map(
    ([name, field]) => `[${JSON.stringify(name)}] = ${luaValue(field)}`,
  );
  return `{ ${fields.join(", ")} }`;
}

function event(fields: Record<string, unknown>) {
  return {
    actor_kind: "agent",
    actor_name: "claude-code_2-1-330_agent",
    actor_session_id: claudeSession,
    actor_thread_id: null,
    actor_model: "claude-opus-5-5",
    actor_directory: "/home/helly/mdr",
    created_at: 1795721319608,
    ...fields,
  };
}

function run(scenario: Scenario, home = mkdtempSync(join(tmpdir(), "zinn-rex-home-"))): Run {
  if (interpreter === undefined) {
    throw new Error(`The Rex action tests need a Lua 5.1 interpreter: install one of ${interpreters.join(", ")}.`);
  }

  const file = join(mkdtempSync(join(tmpdir(), "zinn-rex-scenario-")), "scenario.lua");
  writeFileSync(file, `return ${luaValue({ module: "zinn.resume_session", ...scenario })}\n`);
  const child = Bun.spawnSync([interpreter, harness, rexDirectory, file], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
  });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString()) as Run;
}

function callsNamed(outcome: Run, name: string) {
  return outcome.calls.filter((call) => call.name === name).map((call) => call.args);
}

function openedBlock(outcome: Run) {
  const windows = callsNamed(outcome, "new_window");
  expect(windows).toHaveLength(1);
  const layout = windows[0]!.layout as { block: { label: string; options: { cwd?: string; initial_input: string } } };
  return { window: windows[0]!, block: layout.block };
}

describe("Zinn: Resume session", () => {
  test("one session opens a tab labelled with the task, typing the host's resume command", () => {
    const outcome = run({ args: { task: "MDR-3" }, zinn: { "activity list": [event({})] } });

    expect(outcome.ok).toBe(true);
    const { window, block } = openedBlock(outcome);
    expect(window.window_label).toBe("MDR-3");
    expect(block.options.initial_input).toBe(`claude --resume ${claudeSession}\r`);
    expect(block.options.cwd).toBe("/home/helly/mdr");
    expect(callsNamed(outcome, "pick")).toHaveLength(0);
  });

  test("the task picker runs only when no task is given", () => {
    const outcome = run({ picks: ["MDR-3"], zinn: { "task list": [], "activity list": [event({})] } });

    const zinnCalls = callsNamed(outcome, "exec").map((argv) => Object.values(argv).slice(1, 3).join(" "));
    expect(zinnCalls).toEqual(["task list", "activity list"]);
    expect(openedBlock(outcome).window.window_label).toBe("MDR-3");
  });

  test("Claude Code starts in the parent folder that holds the session's transcript", () => {
    const home = mkdtempSync(join(tmpdir(), "zinn-rex-home-"));
    const project = join(home, ".claude", "projects", "-home-helly-mdr");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${claudeSession}.jsonl`), "");

    const outcome = run(
      { args: { task: "MDR-3" }, zinn: { "activity list": [event({ actor_directory: "/home/helly/mdr/packages/core" })] } },
      home,
    );

    expect(openedBlock(outcome).block.options.cwd).toBe("/home/helly/mdr");
  });

  test("several sessions are offered newest first, and the picked one opens", () => {
    const outcome = run({
      args: { task: "MDR-3" },
      picks: ["2"],
      zinn: {
        "activity list": [
          event({}),
          event({ created_at: 1795721319000 }),
          event({
            actor_name: "codex",
            actor_session_id: codexSession,
            actor_thread_id: codexSession,
            actor_directory: "/home/helly/mdr",
            created_at: 1795600000000,
          }),
        ],
      },
    });

    const picks = callsNamed(outcome, "pick");
    expect(picks).toHaveLength(1);
    expect((picks[0]!.items as Array<unknown>).length).toBe(2);
    expect(openedBlock(outcome).block.options.initial_input).toBe(`codex resume ${codexSession}\r`);
  });

  test("OpenCode resumes the recorded thread when no session was declared", () => {
    const outcome = run({
      args: { task: "MDR-3" },
      zinn: {
        "activity list": [event({ actor_name: "opencode", actor_session_id: null, actor_thread_id: openCodeSession })],
      },
    });

    expect(openedBlock(outcome).block.options.initial_input).toBe(`opencode --session ${openCodeSession}\r`);
  });

  test("a record without a directory opens the tab without one", () => {
    const outcome = run({
      ctx: { block_id: "block:origin" },
      args: { task: "MDR-3" },
      zinn: { "activity list": [event({ actor_directory: null })] },
      processes: { "block:origin": { child: { pid: 10, cwd: "/home/helly/elsewhere" } } },
    });

    expect(openedBlock(outcome).block.options).not.toHaveProperty("cwd");
  });

  test("a pane this action opened that still runs the session gets focus instead of a new tab", () => {
    const label = `Claude Code ${claudeSession}`;
    const outcome = run({
      args: { task: "MDR-3" },
      zinn: { "activity list": [event({})] },
      blocks: [{ block_id: "block:running", label, placement: "placed" }],
      processes: { "block:running": { child: { pid: 10 }, foreground: { pid: 11 } } },
    });

    expect(callsNamed(outcome, "focus_block")).toEqual([{ block_id: "block:running" }]);
    expect(callsNamed(outcome, "new_window")).toHaveLength(0);
  });

  test("that pane back at its shell prompt gets a new tab", () => {
    const label = `Claude Code ${claudeSession}`;
    const outcome = run({
      args: { task: "MDR-3" },
      zinn: { "activity list": [event({})] },
      blocks: [{ block_id: "block:idle", label, placement: "placed" }],
      processes: { "block:idle": { child: { pid: 10 }, foreground: { pid: 10 } } },
    });

    expect(callsNamed(outcome, "focus_block")).toHaveLength(0);
    openedBlock(outcome);
  });

  test("a task changed only by people or unknown agents opens nothing", () => {
    const outcome = run({
      args: { task: "MDR-3" },
      zinn: {
        "activity list": [
          event({ actor_kind: "human", actor_name: "Helly R.", actor_session_id: null }),
          event({ actor_name: "claude-codex", actor_session_id: "other" }),
        ],
      },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({ resumed: false, reason: "no_session" });
    expect(callsNamed(outcome, "new_window")).toHaveLength(0);
  });

  test("a session ID that is not a plain ID is never typed into a shell", () => {
    const outcome = run({
      args: { task: "MDR-3" },
      zinn: { "activity list": [event({ actor_session_id: "x; rm -rf ~" })] },
    });

    expect(outcome.result).toMatchObject({ resumed: false, reason: "no_session" });
    expect(callsNamed(outcome, "new_window")).toHaveLength(0);
  });

  test("closing the session list opens nothing", () => {
    const outcome = run({
      args: { task: "MDR-3" },
      picks: [false],
      zinn: { "activity list": [event({}), event({ actor_session_id: "11e7f0aa-0000-4000-8000-000000000000" })] },
    });

    expect(outcome.result).toMatchObject({ resumed: false, reason: "cancelled" });
    expect(callsNamed(outcome, "new_window")).toHaveLength(0);
  });
});
