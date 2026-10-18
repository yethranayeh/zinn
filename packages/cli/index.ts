#!/usr/bin/env bun

import packageJson from "./package.json" with { type: "json" };
import { versionSpellings } from "./src/input.js";

const args = process.argv.slice(2);
const isVersionRequest = args.length === 1 && versionSpellings.includes(args[0]!);

if (isVersionRequest) {
  console.info(packageJson.version);
} else {
  const { isHelpFlag, prepareOutput, flushDiagnostics, renderFailure } =
    await import("./src/lib.js");

  prepareOutput(args);

  try {
    const { createRouter } = await import("./src/routes/router.js");
    const { routes } = await import("./src/routes/routes.js");
    const router = createRouter(routes, async (command) => {
      if (command.effects.storage === "none") {
        return;
      }
      const { configureDatabase } = await import("@zinn-dev/core");
      const { getCliOpenPolicy } = await import("./src/database.js");
      configureDatabase(getCliOpenPolicy());
    });

    if (args.length === 0 || isHelpFlag(args[0]!)) {
      console.info(router.help);
      flushDiagnostics();
    } else {
      await router.route(args);
    }
  } catch (error) {
    renderFailure(error);
  }
}
