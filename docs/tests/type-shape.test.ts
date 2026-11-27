import { expect, test } from "bun:test";
import { typeShape, typeShapeProps } from "../src/components/docs/type-shape";
import { exportedPropertyNames } from "./type-shape-source";

const core = "packages/core/index.ts";
const cliSchemas = "packages/cli/src/result-schemas.ts";

function declaredProperties(shape: string) {
  return [...shape.matchAll(/^\t(\w+)\??:/gm)].map((match) => match[1]);
}

test("a Pick type prints the fields it resolves to, in order", () => {
  const shape = typeShape(core, ["TaskAttribution"]);
  expect(shape).not.toContain("Pick<");
  expect(declaredProperties(shape)).toEqual(exportedPropertyNames(core, "TaskAttribution"));
});

test("named types inside an expanded type stay names", () => {
  expect(typeShape(core, ["TaskAttribution"])).toMatch(/actor_kind: ActorKind;/);
});

test("a generic type prints as written", () => {
  const shape = typeShape(core, ["TaskBlamedValue"]);
  expect(shape).toStartWith("type TaskBlamedValue<T> =");
  expect(shape).toMatch(/value: T;/);
});

test("asWritten keeps a type as its source writes it", () => {
  expect(typeShape(core, ["TaskAttribution"], ["TaskAttribution"])).toContain("Pick<");
});

test("names print in the order given, as one block", () => {
  const shape = typeShape(core, ["TaskBlame", "TaskAttribution"]);
  expect(shape.indexOf("type TaskBlame =")).toBeLessThan(shape.indexOf("type TaskAttribution ="));
});

test("a name the file does not export fails with the file and the name", () => {
  expect(() => typeShape(core, ["TaskAttribution", "NotExported"])).toThrow(
    /packages\/core\/index\.ts.*NotExported/,
  );
});

test("a CLI type inferred from a zod schema prints its fields", () => {
  const shape = typeShape(cliSchemas, ["PresentedActor"]);
  expect(shape).not.toContain("infer");
  expect(declaredProperties(shape)).toEqual(exportedPropertyNames(cliSchemas, "PresentedActor"));
});

test("props read the same with single or double quotes, across lines", () => {
  const expected = { from: "packages/core/index.ts", names: ["TaskBlame"], title: "Task blame result shape", asWritten: undefined };
  expect(typeShapeProps(`<TypeShape from="packages/core/index.ts" names={["TaskBlame"]} title="Task blame result shape" />`)).toEqual(expected);
  expect(typeShapeProps(`<TypeShape\n\tfrom='packages/core/index.ts'\n\tnames={["TaskBlame"]}\n\ttitle='Task blame result shape'\n/>`)).toEqual(expected);
});
