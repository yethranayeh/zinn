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
  if (["-h", "--help"].includes(firstArg)) {
    console.info(`ZINN - A kanban workflow in the terminal

Usage: zinn <command>

Options:
  -h, --help  Show help

Commands:
  project create
  project list
  project delete
  project column create
  project column list
  task create
  task list
  task view
  task edit
  task move
  task order
  task archive
  task unarchive
  task delete

Run zinn <namespace> --help or zinn <command> --help for more information.
Running zinn without a command opens the work-in-progress TUI in an interactive terminal.`);
  } else {
    const { createRouter } = await import("./src/routes/router");
    const { routes } = await import("./src/routes/routes");
    const router = createRouter(routes);
    router.route(args);
  }
}
