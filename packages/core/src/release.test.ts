import { expect, test } from "bun:test";
import packageJson from "../package.json";
import { readCoreReleaseMode } from "./release";

test("checked-in core identity is source", () => {
  expect(readCoreReleaseMode()).toBe("source");
});

test("published files come from build output while workspace links stay on source", () => {
  expect(packageJson.publishConfig.directory).toBe("dist");
  expect(packageJson.publishConfig.linkDirectory).toBe(false);
  expect(packageJson.files).toContain("index.js");
});
