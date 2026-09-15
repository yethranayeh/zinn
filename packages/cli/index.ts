#!/usr/bin/env bun

const args = process.argv.slice(2);

if (args.length === 0 || ["-h", "--help"].includes(args[0]!)) {
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
Running zinn without a command shows this help.`);
} else {
  const { createRouter } = await import("./src/routes/router");
  const { routes } = await import("./src/routes/routes");
  const router = createRouter(routes);
  router.route(args);
}
