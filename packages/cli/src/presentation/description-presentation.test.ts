import { expect, test } from "bun:test";
import { formatDescriptionPreview } from "./description-presentation";
import { displayWidth } from "./text-width";

test("visual previews preserve complete graphemes within the cell budget", () => {
  const cases: Array<[string, number, string]> = [
    ["a😀z", 3, "a…"],
    ["a😀zz", 4, "a😀…"],
    ["a👨‍👩‍👧‍👦z", 3, "a…"],
    ["a👨‍👩‍👧‍👦zz", 4, "a👨‍👩‍👧‍👦…"],
    ["ae\u0301zz", 3, "ae\u0301…"],
    ["界界z", 4, "界…"],
    ["界界", 4, "界界"],
    [" x   y ", 3, "x y"],
  ];
  for (const [input, maxLength, expected] of cases) {
    const preview = formatDescriptionPreview(input, { maxLength });
    expect(preview).toBe(expected);
    expect(displayWidth(preview)).toBeLessThanOrEqual(maxLength);
  }
  expect(formatDescriptionPreview("x".repeat(22) + "😀z", { maxLength: 24 }))
    .toBe("x".repeat(22) + "…");
});

test("first-line previews mark omitted lines and preserve normalized whitespace", () => {
  expect(formatDescriptionPreview("  a\t b \r\nother", { firstLineOnly: true })).toBe("a b…");
  expect(formatDescriptionPreview("\nother", { firstLineOnly: true })).toBe("…");
  expect(formatDescriptionPreview("😀\nother", { maxLength: 2, firstLineOnly: true })).toBe("…");
});
