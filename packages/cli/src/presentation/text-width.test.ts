import { expect, test } from "bun:test";
import { displayWidth } from "./text-width";

test("terminal width counts graphemes, emoji, and East Asian cells", () => {
  const cases: Array<[string, number]> = [
    ["Plain ASCII", 11],
    ["é", 1],
    ["e\u0301", 1],
    ["界", 2],
    ["カ", 2],
    ["𛀁", 2],
    ["ｶ", 1],
    ["한", 2],
    ["😀", 2],
    ["👍🏽", 2],
    ["👨‍👩‍👧‍👦", 2],
    ["🇩🇪", 2],
    ["1️⃣", 2],
    ["\u200b", 0],
    ["\u0301", 0],
    ["\u0007", 0],
  ];
  for (const [text, width] of cases) {
    expect(displayWidth(text)).toBe(width);
  }
});
