import { expect, test } from "bun:test";

import {
  describeDifferences,
  inspectSample,
  knownGoodDirectory,
  loadKnownGood,
  newestKnownGood,
} from "./preflight.ts";
import { isPlistDict } from "./plist.ts";

const BUILD = "24G517";

test("the known-good sample has no preflight issues", () => {
  const record = loadKnownGood(BUILD, knownGoodDirectory());
  expect(record).toBeDefined();
  expect(inspectSample(record!)).toEqual([]);
});

test("a missing combined_power is reported against the known-good sample", () => {
  const record = loadKnownGood(BUILD, knownGoodDirectory())!;
  const broken = structuredClone(record);
  const processor = broken.processor;
  if (isPlistDict(processor)) {
    delete processor.combined_power;
  }
  const issues = inspectSample(broken);
  expect(issues.some((issue) => issue.path === "processor.combined_power")).toBe(true);
  const differences = describeDifferences(broken, record).join("\n");
  expect(differences).toContain("processor.combined_power");
});

test("implausible power and elapsed values are rejected", () => {
  const record = structuredClone(loadKnownGood(BUILD, knownGoodDirectory())!);
  const processor = record.processor;
  if (!isPlistDict(processor)) {
    throw new Error("The known-good sample has no processor dictionary");
  }
  processor.combined_power = 250_000;
  record.elapsed_ns = 1_000_000_000;
  const paths = inspectSample(record).map((issue) => issue.path);
  expect(paths).toContain("processor.combined_power");
  expect(paths).toContain("elapsed_ns");
});

test("an unknown build has no known-good sample and the newest one is still found", () => {
  expect(loadKnownGood("99Z999", knownGoodDirectory())).toBeUndefined();
  expect(newestKnownGood(knownGoodDirectory())?.name).toBe(`${BUILD}.plist`);
});
