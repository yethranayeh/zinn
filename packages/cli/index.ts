const args = process.argv.slice(2);

if (args.length === 0) {
  if (!!process.stdout.isTTY) {
    const tui = await import("@zinn-dev/tui");
    tui.launch();
  } else {
    console.error("Direct launch in a non-TTY environment is not supported.");
    process.exit(1);
  }
} else {
  // TODO: headless CLI
}
