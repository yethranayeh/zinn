import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isPrerelease } from "../../../../packages/core/src/release.ts";

const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
if (isPrerelease(manifest.version)) {
  throw new Error(
    `Refusing to publish ${manifest.name} ${manifest.version}. Set the release version first.`,
  );
}
