import { expect, test } from "bun:test";
import { latestVersion } from "../src/config/latest-release";

test("the latest release is the highest version, not the last file", () => {
  expect(latestVersion(["0.9.0", "0.10.0", "0.3.1"])).toBe("0.10.0");
});

test("an empty release line has no latest version", () => {
  expect(latestVersion([])).toBeUndefined();
});
