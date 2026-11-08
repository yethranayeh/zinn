import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCommandLine,
  buildHyperfineArguments,
  buildPrepareCommand,
  readHyperfineSummary,
} from "./hyperfine.ts";

const environment = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/test",
  ZINN_DIR: "/cache/0.44.0/runs/t100",
};
const nodePath = "/usr/local/bin/node";
const cliIndex = "/cache/0.44.0/install/node_modules/@zinn-dev/cli/index.js";

test("a measured command runs under env -i with only PATH, HOME and ZINN_DIR", () => {
  expect(
    buildCommandLine({
      environment,
      argv: [nodePath, cliIndex, "task", "create", "BNCH", "--title", "one two three"],
    }),
  ).toBe(
    "env -i PATH=/usr/bin:/bin HOME=/Users/test ZINN_DIR=/cache/0.44.0/runs/t100 " +
      "/usr/local/bin/node /cache/0.44.0/install/node_modules/@zinn-dev/cli/index.js " +
      "task create BNCH --title 'one two three'",
  );
});

test("the prepare command resets the database and the backups folder", () => {
  expect(
    buildPrepareCommand({
      databasePath: "/cache/0.44.0/runs/t100/data/zinn.sqlite",
      backupDirectory: "/cache/0.44.0/runs/t100/backups",
      fixtureDatabasePath: "/cache/0.44.0/fixtures/t100-c1/data/zinn.sqlite",
    }),
  ).toBe(
    "rm -rf /cache/0.44.0/runs/t100/data/zinn.sqlite " +
      "/cache/0.44.0/runs/t100/data/zinn.sqlite-wal " +
      "/cache/0.44.0/runs/t100/data/zinn.sqlite-shm " +
      "/cache/0.44.0/runs/t100/backups && cp " +
      "/cache/0.44.0/fixtures/t100-c1/data/zinn.sqlite " +
      "/cache/0.44.0/runs/t100/data/zinn.sqlite",
  );
});

test("one hyperfine call carries each named command and its prepare step", () => {
  const args = buildHyperfineArguments({
    runs: 3,
    warmup: 1,
    prepare: "prepare here",
    exportPath: "/results/t100.json",
    entries: [
      { name: "list", command: "env -i list" },
      { name: "view", command: "env -i view" },
    ],
  });
  expect(args).toEqual([
    "hyperfine",
    "-N",
    "--warmup",
    "1",
    "--runs",
    "3",
    "--prepare",
    "prepare here",
    "--export-json",
    "/results/t100.json",
    "-n",
    "list",
    "env -i list",
    "-n",
    "view",
    "env -i view",
  ]);
});

test("a startup call has no prepare step", () => {
  const args = buildHyperfineArguments({
    runs: 30,
    warmup: 3,
    exportPath: "/results/startup.json",
    entries: [{ name: "node -e 0", command: "env -i node -e 0" }],
  });
  expect(args).not.toContain("--prepare");
  expect(args.slice(0, 6)).toEqual(["hyperfine", "-N", "--warmup", "3", "--runs", "30"]);
});

test("the hyperfine export is read from measurements, not the times array", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-hyperfine-"));
  try {
    const filePath = join(root, "t100.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        schema_version: 2,
        results: [
          {
            command: "env -i task list BNCH",
            name: "list",
            measurements: [
              {
                time_wall_clock: { value: 1, unit: "second" },
                memory_peak_resident: { value: 100, unit: "byte" },
              },
              {
                time_wall_clock: { value: 3, unit: "second" },
                memory_peak_resident: { value: 300, unit: "byte" },
              },
              {
                time_wall_clock: { value: 2, unit: "second" },
                memory_peak_resident: { value: 200, unit: "byte" },
              },
            ],
          },
        ],
      }),
    );
    expect(await readHyperfineSummary(filePath, ["list"])).toEqual({
      list: { p50WallSeconds: 2, p95WallSeconds: 3, medianPeakBytes: 200 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
