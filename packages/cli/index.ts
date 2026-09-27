#!/usr/bin/env bun

import { isHelpFlag } from "./src/lib";
import packageJson from "./package.json";

const args = process.argv.slice(2);
const isVersionRequest = args.length === 1 && ["-v", "--version"].includes(args[0]!);

if (isVersionRequest) {
  console.info(packageJson.version);
} else {
  const { createRouter } = await import("./src/routes/router");
  const { routes } = await import("./src/routes/routes");
  const router = createRouter(routes);

  if (args.length === 0 || isHelpFlag(args[0]!)) {
    console.info(`ZINN - A kanban workflow in the terminal

Usage: zinn <command>

Options:
  -h, --help  Show help
  -v, --version  Show version
  --json      Print command output as JSON

Commands:
${router.commands}

Run zinn <namespace> --help or zinn <command> --help for more information.
Running zinn without a command shows this help.`);
  } else {
    router.route(args);
  }
}
