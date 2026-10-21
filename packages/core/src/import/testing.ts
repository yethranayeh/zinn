import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";

const [scenario, target, repository] = process.argv.slice(2);
assert.ok(target);
const core = await import("../../index");
if (scenario === "environment") {
  process.env.ZINN_DIR = target;
  const { directory, source } = core.getStorage();
  console.log(JSON.stringify({ directory, source, sameOnReuse: core.getStorage() === core.getStorage() }));
} else {
  assert.equal(scenario, "settings");
  assert.ok(repository);
  writeFileSync(target, JSON.stringify({ storage: { directory: "store" } }));
  process.chdir(repository);
  const { directory, source } = core.getStorage();
  console.log(JSON.stringify({ directory, source }));
}
