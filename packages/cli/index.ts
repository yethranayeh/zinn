#!/usr/bin/env bun
import { quit } from "./src/lib";

const args = process.argv.slice(2);

if (args.length === 0) {
  if (!!process.stdout.isTTY) {
    const tui = await import("@zinn-dev/tui");
    tui.launch();
  } else {
    quit("Direct launch in a non-TTY environment is not supported.");
  }
} else {
  // TODO: isTTY check for human readable colored and structured formatting like tables
  const firstArg = args[0]!;
  // TODO: root routing with flags
  if (firstArg === "--help") {
    // TODO: document that project keys are always uppercased
    console.info(`ZINN - A kanban workflow in the terminal

      usage: zinn [options]
      -h, --help  For help using Zinn`);
  } else {
    const { createRouter } = await import("./src/routes/router");
    const { routes } = await import("./src/routes/routes");
    const router = createRouter(routes);
    router.route(args);
  }
}
