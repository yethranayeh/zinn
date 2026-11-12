import { expect, test } from "bun:test";

import { parseSpotlightStatus } from "./settings.ts";

test("spotlight status keeps on, off and read-only volumes apart", () => {
  const output = [
    "/:",
    "\tIndex is read-only.",
    "/System/Volumes/Data:",
    "\tIndexing enabled. ",
    "/Volumes/Backup:",
    "\tIndexing disabled.",
    "/Volumes/Odd:",
    "\tSomething new.",
    "",
  ].join("\n");
  expect(parseSpotlightStatus(output)).toEqual([
    { volume: "/", enabled: "read-only" },
    { volume: "/System/Volumes/Data", enabled: true },
    { volume: "/Volumes/Backup", enabled: false },
    { volume: "/Volumes/Odd", enabled: undefined },
  ]);
});
