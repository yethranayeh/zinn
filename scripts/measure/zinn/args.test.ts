import { expect, test } from "bun:test";

import {
  CHECK_IDLE_SECONDS,
  CHECK_ROUNDS,
  CHECK_SETTLE_SECONDS,
  CHECK_WORK_SECONDS,
  DEFAULT_ENERGY_IDLE_SECONDS,
  DEFAULT_ENERGY_ROUNDS,
  DEFAULT_ENERGY_SETTLE_SECONDS,
  DEFAULT_ENERGY_WORK_SECONDS,
  DEFAULT_RUNS,
  DEFAULT_SIZES,
  DEFAULT_WARMUP,
  parseArguments,
  type EnergyArguments,
  type TimeArguments,
} from "./args.ts";
import { COMMAND_NAMES } from "./commands.ts";

function timeArguments(args: string[]): TimeArguments {
  const parsed = parseArguments(args);
  if (parsed.kind !== "time") {
    throw new Error(`Expected time arguments, got ${parsed.kind}`);
  }
  return parsed;
}

function errorArguments(args: string[]): string {
  const parsed = parseArguments(args);
  if (parsed.kind !== "error") {
    throw new Error(`Expected an argument error, got ${parsed.kind}`);
  }
  return parsed.message;
}

function energyArguments(args: string[]): EnergyArguments {
  const parsed = parseArguments(args);
  if (parsed.kind !== "energy") {
    throw new Error(`Expected energy arguments, got ${parsed.kind}`);
  }
  return parsed;
}

test("time defaults to the three sizes, 30 runs and every command", () => {
  const parsed = timeArguments(["time", "0.44.0"]);
  expect(parsed.version).toBe("0.44.0");
  expect(parsed.sizes).toEqual([...DEFAULT_SIZES]);
  expect(parsed.runs).toBe(DEFAULT_RUNS);
  expect(parsed.warmup).toBe(DEFAULT_WARMUP);
  expect(parsed.commands).toEqual([...COMMAND_NAMES]);
});

test("time reads sizes, runs, warmup and a command subset", () => {
  const parsed = timeArguments([
    "time",
    "0.44.0",
    "--sizes",
    "100,1000",
    "--runs",
    "3",
    "--warmup",
    "1",
    "--commands",
    "view,list",
  ]);
  expect(parsed.sizes).toEqual([100, 1_000]);
  expect(parsed.runs).toBe(3);
  expect(parsed.warmup).toBe(1);
  expect(parsed.commands).toEqual(["list", "view"]);
});

test("options also accept an equals sign", () => {
  const parsed = timeArguments([
    "time",
    "0.44.0",
    "--sizes=100,1000,10000",
    "--runs=5",
    "--warmup=2",
    "--commands=list-json,backup",
  ]);
  expect(parsed.sizes).toEqual([100, 1_000, 10_000]);
  expect(parsed.runs).toBe(5);
  expect(parsed.warmup).toBe(2);
  expect(parsed.commands).toEqual(["list-json", "backup"]);
});

test("repeated sizes are measured once", () => {
  expect(timeArguments(["time", "0.44.0", "--sizes", "100,100,1000"]).sizes).toEqual([
    100,
    1_000,
  ]);
});

test("disk takes only a release version", () => {
  expect(parseArguments(["disk", "0.44.0"])).toEqual({ kind: "disk", version: "0.44.0" });
  expect(parseArguments(["disk", "0.44.0", "--runs", "3"]).kind).toBe("error");
});

test("prerelease versions are accepted", () => {
  expect(timeArguments(["time", "0.44.0-beta.1"]).version).toBe("0.44.0-beta.1");
});

test("bad arguments are refused", () => {
  expect(parseArguments([]).kind).toBe("error");
  expect(errorArguments(["timing", "0.44.0"])).toContain("timing");
  expect(errorArguments(["time"])).toContain("version");
  expect(errorArguments(["time", "latest"])).toContain("latest");
  expect(errorArguments(["time", "0.44.0", "--sizes", "0"])).toContain("--sizes");
  expect(errorArguments(["time", "0.44.0", "--sizes", "100,abc"])).toContain("--sizes");
  expect(errorArguments(["time", "0.44.0", "--sizes", "100,"])).toContain("--sizes");
  expect(errorArguments(["time", "0.44.0", "--runs", "0"])).toContain("--runs");
  expect(errorArguments(["time", "0.44.0", "--warmup", "-1"])).toContain("--warmup");
  expect(errorArguments(["time", "0.44.0", "--commands", "explode"])).toContain("--commands");
  expect(errorArguments(["time", "0.44.0", "--unknown"])).toContain("--unknown");
});

test("energy defaults to five full rounds and the fixed default workloads", () => {
  const parsed = energyArguments(["energy", "0.44.0"]);
  expect(parsed.rounds).toBe(DEFAULT_ENERGY_ROUNDS);
  expect(parsed.idleSeconds).toBe(DEFAULT_ENERGY_IDLE_SECONDS);
  expect(parsed.workSeconds).toBe(DEFAULT_ENERGY_WORK_SECONDS);
  expect(parsed.settleSeconds).toBe(DEFAULT_ENERGY_SETTLE_SECONDS);
  expect(parsed.commands).toBeUndefined();
  expect(parsed.sizes).toBeUndefined();
});

test("energy --check shortens the round for a two minute confirmation", () => {
  const parsed = energyArguments(["energy", "0.44.0", "--check"]);
  expect(parsed.rounds).toBe(CHECK_ROUNDS);
  expect(parsed.idleSeconds).toBe(CHECK_IDLE_SECONDS);
  expect(parsed.workSeconds).toBe(CHECK_WORK_SECONDS);
  expect(parsed.settleSeconds).toBe(CHECK_SETTLE_SECONDS);
});

test("energy reads rounds, command and size overrides", () => {
  const parsed = energyArguments([
    "energy",
    "0.44.0",
    "--rounds",
    "3",
    "--commands",
    "view,list",
    "--sizes",
    "100,1000",
  ]);
  expect(parsed.rounds).toBe(3);
  expect(parsed.commands).toEqual(["list", "view"]);
  expect(parsed.sizes).toEqual([100, 1_000]);
});

test("energy-analyze takes two paths and no version", () => {
  expect(parseArguments(["energy-analyze", "power.plist", "blocks.tsv"])).toEqual({
    kind: "energy-analyze",
    powerPath: "power.plist",
    blocksPath: "blocks.tsv",
  });
});

test("energy-analyze takes session samples as an optional third path", () => {
  expect(parseArguments(["energy-analyze", "power.plist", "blocks.tsv", "samples.tsv"])).toEqual({
    kind: "energy-analyze",
    powerPath: "power.plist",
    blocksPath: "blocks.tsv",
    samplesPath: "samples.tsv",
  });
  expect(parseArguments(["energy-analyze", "a", "b", "c", "d"]).kind).toBe("error");
});

test("bad energy arguments are refused", () => {
  expect(errorArguments(["energy"])).toContain("version");
  expect(errorArguments(["energy", "latest"])).toContain("latest");
  expect(errorArguments(["energy", "0.44.0", "--rounds", "0"])).toContain("--rounds");
  expect(errorArguments(["energy", "0.44.0", "--rounds"])).toContain("--rounds");
  expect(errorArguments(["energy", "0.44.0", "--sizes", "100,abc"])).toContain("--sizes");
  expect(errorArguments(["energy", "0.44.0", "--commands", "explode"])).toContain("--commands");
  expect(errorArguments(["energy", "0.44.0", "--unknown"])).toContain("--unknown");
  expect(errorArguments(["energy-analyze"])).toContain("power plist");
  expect(errorArguments(["energy-analyze", "power.plist"])).toContain("power plist");
});
