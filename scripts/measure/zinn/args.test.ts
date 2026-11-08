import { expect, test } from "bun:test";

import {
  DEFAULT_RUNS,
  DEFAULT_SIZES,
  DEFAULT_WARMUP,
  parseArguments,
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
