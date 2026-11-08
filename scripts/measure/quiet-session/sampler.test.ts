import { expect, test } from "bun:test";

import { parseArguments } from "./args.ts";
import { parseLoadAverages, parseProcesses } from "./sampler.ts";

test("process rows keep commands with spaces whole", () => {
  const rows = parseProcesses(
    " 61.7 574864 10131 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n\n  0.0   16     1 /sbin/launchd\n",
  );
  expect(rows).toEqual([
    {
      cpu: "61.7",
      rssKb: "574864",
      pid: "10131",
      command: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    },
    { cpu: "0.0", rssKb: "16", pid: "1", command: "/sbin/launchd" },
  ]);
});

test("load averages are read from sysctl output", () => {
  expect(parseLoadAverages("{ 13.75 13.19 13.05 }\n")).toEqual(["13.75", "13.19", "13.05"]);
});

test("--sample-seconds takes a whole number of seconds", () => {
  for (const args of [["--sample-seconds", "2", "--", "true"], ["--sample-seconds=2", "--", "true"]]) {
    const parsed = parseArguments(args);
    expect(parsed.kind === "session" && parsed.sampleSeconds).toBe(2);
  }
  for (const value of ["0", "1.5", "x"]) {
    expect(parseArguments(["--sample-seconds", value, "--", "true"]).kind).toBe("error");
  }
  expect(parseArguments(["--sample-seconds"]).kind).toBe("error");
});
