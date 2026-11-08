import { expect, test } from "bun:test";

import { computeDiskSlopes } from "./disk.ts";

test("the disk slopes match the published fixture sizes", () => {
  expect(
    computeDiskSlopes({
      "t1000-c0": 1_748_992,
      "t10000-c0": 15_802_368,
      "t10000-c1": 29_044_736,
    }),
  ).toEqual({ perTask: 1_561, perComment: 1_324 });
});

test("a missing fixture is refused", () => {
  expect(() =>
    computeDiskSlopes({
      "t1000-c0": 1_748_992,
      "t10000-c0": 15_802_368,
    }),
  ).toThrow();
});
