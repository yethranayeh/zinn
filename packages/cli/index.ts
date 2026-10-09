#!/usr/bin/env bun

import packageJson from "./package.json";

const args = process.argv.slice(2);
const isVersionRequest = args.length === 1 && ["-v", "--version"].includes(args[0]!);

if (isVersionRequest) {
  console.info(packageJson.version);
} else {
  const { isHelpFlag } = await import("./src/lib");
  const { createRouter } = await import("./src/routes/router");
  const { routes } = await import("./src/routes/routes");
  const router = createRouter(routes);

  if (args.length === 0 || isHelpFlag(args[0]!)) {
    console.info(router.help);
  } else {
    const { configureDatabase } = await import("@zinn-dev/core");
    const { cliOpenPolicy } = await import("./src/database");

    // Only records the policy. core then opens the database when a command first uses it.
    configureDatabase(cliOpenPolicy());
    router.route(args);
  }
}
