const args = process.argv.slice(2);
const FLAG = {
  help: ["-h", "--help"],
  project: ["project"],
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
    const { createProject } = await import("@zinn-dev/core");

    if (FLAG.project.includes(firstArg)) {
      const secondArg = args[1];
      if (secondArg == null) {
        // TODO: implement `zinn project --help` for better guiding
        console.error(
          `The command "${firstArg}" requires a secondary command: zinn ${firstArg} <command>`,
        );
        process.exit(1);
      } else if (FLAG.create.includes(secondArg)) {
        createProject();
      }
    } else {
      console.error(
        `Unrecognized command "${firstArg}". Please run \`zinn --help\` for a list of available commands`,
      );
      process.exit(1);
    }
  }
}
