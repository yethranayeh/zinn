// Main entry point, will replace the code currently published on https://www.npmjs.com/package/@zinn-dev/cli

const args = process.argv.slice(2);

if (args.length === 0) {
  const tui = await import("@zinn-dev/tui");
  tui.launch();
} else {
  // TODO: headless CLI
}
