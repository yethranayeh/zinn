import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type OutputOptions = { imports?: Record<string, unknown>; bin?: Record<string, string> };

/** Writes the package metadata and documents accompanying emitted modules. */
export function writePackageOutput(packageDirectory: string, options: OutputOptions) {
  const { scripts, module, exports, publishConfig, imports, bin, ...metadata } = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  );
  const outputDirectory = join(packageDirectory, "dist");
  const manifest = {
    ...metadata,
    ...options,
    module: "index.js",
    types: "./index.d.ts",
    exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    publishConfig: { access: publishConfig.access },
  };

  writeFileSync(join(outputDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of ["README.md", "LICENSE"]) {
    copyFileSync(join(packageDirectory, name), join(outputDirectory, name));
  }
}
