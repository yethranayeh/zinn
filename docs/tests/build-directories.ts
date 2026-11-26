import { join, resolve } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");

// The deploy script builds into its own folders and names them here. Other runs test the default build output.
export const siteBuildDirectory = process.env.SITE_BUILD_DIRECTORY ?? join(docsDirectory, "dist");
export const foundryBuildDirectory =
  process.env.FOUNDRY_BUILD_DIRECTORY ?? join(docsDirectory, "dist-foundry");
