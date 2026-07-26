const args = process.argv.slice(2);

if (args.length === 0) {
  if (!!process.stdout.isTTY) {
    const tui = await import("@zinn-dev/tui");
    tui.launch();
  } else {
    // TODO: non interative branch
  }
} else {
  // TODO: headless CLI
}
