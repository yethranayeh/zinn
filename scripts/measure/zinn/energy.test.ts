import { expect, test } from "bun:test";

import { parseArguments, type EnergyArguments } from "./args.ts";
import { energyWorkloadLabel, energyWorkloadPlan } from "./energy.ts";

function planFor(args: string[]) {
  const parsed = parseArguments(args);
  if (parsed.kind !== "energy") {
    throw new Error(`Expected energy arguments, got ${parsed.kind}`);
  }
  return energyWorkloadPlan(parsed).map(energyWorkloadLabel);
}

function defaults(): EnergyArguments {
  const parsed = parseArguments(["energy", "0.44.0"]);
  if (parsed.kind !== "energy") {
    throw new Error("Expected energy arguments");
  }
  return parsed;
}

test("the default plan is node plus four commands at 100 and list at 10000", () => {
  expect(planFor(["energy", "0.44.0"])).toEqual([
    "node",
    "list@100",
    "list-json@100",
    "view@100",
    "create@100",
    "list@10000",
  ]);
  expect(defaults().rounds).toBe(5);
});

test("command and size overrides make a cross product plus node", () => {
  expect(
    planFor([
      "energy",
      "0.44.0",
      "--commands",
      "view,list",
      "--sizes",
      "100,1000",
    ]),
  ).toEqual(["node", "list@100", "list@1000", "view@100", "view@1000"]);
});
