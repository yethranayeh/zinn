import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "./build";
import { INSPECTOR_VERSION } from "./src/runtime";

export async function packageIntegration(output: string, destination: string) {
  await build(output);

  const files: Record<string, Uint8Array> = {};
  for (const file of readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) {
      const absolute = join(file.parentPath, file.name);
      const relative = absolute.slice(output.length + 1);
      files[`zinn-codex/${relative}`] = await Bun.file(absolute).bytes();
    }
  }

  mkdirSync(destination, { recursive: true });

  const archive = join(destination, `zinn-codex-${INSPECTOR_VERSION}.tar.gz`);

  await Bun.Archive.write(archive, files, { compress: "gzip" });

  const sha256 = createHash("sha256")
    .update(await Bun.file(archive).bytes())
    .digest("hex");

  writeFileSync(archive + ".sha256", `${sha256}  zinn-codex-${INSPECTOR_VERSION}.tar.gz\n`);
  return { archive, sha256 };
}

if (import.meta.main) {
  const output = join(import.meta.dir, "dist");
  rmSync(output, { recursive: true, force: true });

  console.log(
    JSON.stringify(await packageIntegration(output, join(import.meta.dir, "release-dist"))),
  );
}
