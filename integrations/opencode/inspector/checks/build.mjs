import { transformSync } from "@babel/core";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dir, "..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const source = resolve(argument("--source") ?? join(packageDirectory, "pkg"));
const output = resolve(argument("--output") ?? join(packageDirectory, "dist"));

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const file of readdirSync(source)) {
  if (!/\.(ts|tsx)$/.test(file) || file.endsWith(".test.ts")) {
    continue;
  }
  // Compile JSX against @opentui/solid so it shares the plugin's Solid instance.
  const result = transformSync(readFileSync(join(source, file), "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    presets: [
      ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
      ["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid" }],
    ],
  });
  if (result?.code === null || result?.code === undefined) {
    throw new Error(`Babel produced no code for ${file}`);
  }
  const code = result.code.replace(/(from\s+["'])(\.\/[^"']+)\.(ts|tsx)(["'])/g, "$1$2.js$4");
  writeFileSync(join(output, file.replace(/\.(ts|tsx)$/, ".js")), code);
}

if (!readdirSync(output).includes("tui.js")) {
  throw new Error("The build did not produce tui.js");
}
