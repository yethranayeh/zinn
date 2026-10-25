import { expect, test } from "bun:test";
import { withEnvironment } from "../../../core/src/testing";
import { formatRows } from "./row-layout";
import { displayWidth } from "./text-width";

const ANSI_STYLE = /\x1b\[[0-9;]*m/g;

test("Unicode row cells align separators with and without color", () => {
  for (const color of ["0", "1"]) {
    withEnvironment({ FORCE_COLOR: color, NO_COLOR: undefined }, () => {
      const output = formatRows([
        [{ text: "界", style: "green" }, { text: "😀", style: "red" }, { text: "first" }],
        [{ text: "AB" }, { text: "e\u0301", style: "green" }, { text: "second" }],
      ]);
      const lines = output.split("\n").map((line) => line.replace(ANSI_STYLE, ""));
      expect(lines).toEqual(["界 | 😀 | first", "AB | e\u0301  | second"]);
      for (const line of lines) {
        const [first, second] = line.split(" | ");
        expect(displayWidth(first!)).toBe(2);
        expect(displayWidth(second!)).toBe(2);
      }
      if (color === "1") {
        expect(output).toContain("\x1b[32m界\x1b[39m");
        expect(output).toContain("\x1b[32me\u0301 \x1b[39m");
      }
    });
  }
});

test("continuation text starts at the last cell's display column", () => {
  withEnvironment({ FORCE_COLOR: "0" }, () => {
    const lines = formatRows([
      [{ text: "界" }, { text: "😀" }, { text: "first\nnext" }],
      [{ text: "A" }, { text: "e\u0301" }, { text: "second" }],
    ], { indentsContinuationLines: true }).split("\n");
    expect(lines[0]).toBe("界 | 😀 | first");
    expect(lines[1]).toBe("          next");
    expect(displayWidth(lines[1]!.slice(0, lines[1]!.indexOf("next"))))
      .toBe(displayWidth(lines[0]!.slice(0, lines[0]!.indexOf("first"))));
  });
});
