import { expect, test } from "bun:test";

import type { Runner } from "../quiet-session/runner.ts";
import { roundOrders, runBlocks, type Workload } from "./schedule.ts";

test("the seeded round order is stable and holds every label once", () => {
  const labels = ["node", "list@100", "view@100", "create@100", "list@10000"];
  const first = roundOrders(labels, 5);
  expect(roundOrders(labels, 5)).toEqual(first);
  expect(first).toHaveLength(5);
  for (const order of first) {
    expect([...order].sort()).toEqual([...labels].sort());
  }
});

test("the block loop logs idle and work windows with the run count", async () => {
  let clock = 0;
  const calls: Array<{
    argv: readonly string[];
    env?: Record<string, string>;
    discardStdout?: boolean;
  }> = [];
  const runner = {
    async capture(argv: readonly string[], options?: { env?: Record<string, string>; discardStdout?: boolean }) {
      calls.push({ argv, env: options?.env, discardStdout: options?.discardStdout });
      clock += 100;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async interactive() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    spawn() {
      throw new Error("not used");
    },
    pipe() {
      throw new Error("not used");
    },
  } as unknown as Runner;
  const workload: Workload = {
    label: "node",
    async prepare() {
      return {
        argv: ["/bin/true"],
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp", ZINN_DIR: "/tmp/zinn-energy" },
        cwd: "/tmp",
      };
    },
  };

  const rows = await runBlocks({
    workloads: [workload],
    rounds: 1,
    idleSeconds: 2,
    workSeconds: 1,
    settleSeconds: 1,
    runner,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    round: 1,
    label: "node",
    kind: "idle",
    start: 1,
    end: 3,
    count: 0,
  });
  expect(rows[1]).toMatchObject({
    round: 1,
    label: "node",
    kind: "work",
    start: 3,
    end: 4,
    count: 10,
  });
  expect(calls.every((call) => call.discardStdout === true)).toBe(true);
  expect(calls.every((call) => call.env?.ZINN_DIR === "/tmp/zinn-energy")).toBe(true);
});

test("given orders run as numbered extra rounds, each block after its before hook", async () => {
  let clock = 0;
  const events: string[] = [];
  const runner = {
    async capture() {
      clock += 100;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as Runner;
  const workload = (label: string): Workload => ({
    label,
    async prepare() {
      events.push(`prepare ${label}`);
      return { argv: ["/bin/true"], env: {} };
    },
  });

  const rows = await runBlocks({
    workloads: [workload("a"), workload("b")],
    rounds: 5,
    idleSeconds: 1,
    workSeconds: 1,
    settleSeconds: 1,
    runner,
    orders: [["b"]],
    firstRound: 6,
    beforeBlock: async (round, label) => {
      events.push(`before ${round} ${label}`);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });

  expect(events).toEqual(["before 6 b", "prepare b"]);
  expect(rows.map((row) => [row.round, row.label, row.kind])).toEqual([
    [6, "b", "idle"],
    [6, "b", "work"],
  ]);
});
