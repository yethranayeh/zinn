/**
 * Writes or removes the release stamp of the package in the current folder:
 *   `bun ../../scripts/release-stamp.ts write`    from the package's prepack script
 *   `bun ../../scripts/release-stamp.ts remove`   from its postpack script
 * Packing runs both, so only the packed package keeps the stamp.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PUBLISHED_STAMP, RELEASE_STAMP_FILE } from "../packages/core/src/release.ts";

const stampPath = join(process.cwd(), RELEASE_STAMP_FILE);
const action = process.argv[2];

if (action === "write") {
  writeFileSync(stampPath, `${JSON.stringify(PUBLISHED_STAMP)}\n`);
} else if (action === "remove") {
  rmSync(stampPath, { force: true });
} else {
  throw new Error("Usage: bun scripts/release-stamp.ts {write|remove}");
}
