import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { knownGoodPath } from "./preflight.ts";
import { parsePlist, plistPath } from "./plist.ts";
import { parsePowerLog } from "./samples.ts";

const BUILD = "24G517";

function knownGoodText(): string {
  return readFileSync(knownGoodPath(`${import.meta.dir}/known-good`, BUILD), "utf8");
}

test("the known-good sample parses into the fields the preflight checks", () => {
  const record = parsePlist(knownGoodText());
  expect(record.kern_osversion).toBe(BUILD);
  expect(record.hw_model).toBe("Mac16,1");
  expect(typeof record.elapsed_ns).toBe("number");
  expect(record.timestamp).toBeInstanceOf(Date);
  expect(plistPath(record, "processor.combined_power")).toBeCloseTo(120.996, 3);
});

test("the parser reads arrays, reals, strings, dates and booleans", () => {
  const record = parsePlist(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>array</key><array><integer>1</integer><real>1.5</real></array>
  <key>text</key><string>a &amp; b</string>
  <key>when</key><date>2026-11-08T18:18:03Z</date>
  <key>yes</key><true/>
  <key>no</key><false/>
</dict>
</plist>`);
  expect(record.array).toEqual([1, 1.5]);
  expect(record.text).toBe("a & b");
  expect(record.when).toBeInstanceOf(Date);
  expect(record.yes).toBe(true);
  expect(record.no).toBe(false);
});

test("a cut-off final sample is skipped and complete samples are kept", () => {
  const text = knownGoodText();
  const cutOff = text.slice(0, text.length - 40);
  const samples = parsePowerLog(`${text}\0${cutOff}`);
  expect(samples).toHaveLength(1);
  expect(samples[0]!.powerMw).toBeCloseTo(120.996, 3);
  expect(samples[0]!.seconds).toBeCloseTo(0.50415, 5);
});
