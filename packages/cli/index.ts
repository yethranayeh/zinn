const args = process.argv.slice(2);
const FLAG = {
  help: ["-h", "--help"],
  create: ["create"],
};

if (args.length === 0) {
  if (!!process.stdout.isTTY) {
    const tui = await import("@zinn-dev/tui");
    tui.launch();
  } else {
    console.error("Direct launch in a non-TTY environment is not supported.");
    process.exit(1);
  }
} else {
  // TODO: isTTY check for human readable colored and structured formatting like tables
  const firstArg = args[0]!;
  if (FLAG.help.includes(firstArg)) {
    console.log(`ZINN - A kanban workflow in the terminal

      usage: zinn [options]
      -h, --help  For help using Zinn`);
  } else {
    console.error(
      `Unrecognized command "${firstArg}". Please run \`zinn --help\` for a list of available commands`,
    );
    process.exit(1);
  }
}
