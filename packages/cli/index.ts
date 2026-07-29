#!/usr/bin/env bun

const args = process.argv.slice(2);
const FLAG = {
  help: ["-h", "--help"],
  project: ["project"],
  task: ["task"],
  create: ["create"],
  delete: ["delete"],
};

const MESSAGE = {
  displayUnknownCommand: (cmd: string) =>
    `Unrecognized command "${cmd}". Please run \`zinn --help\` for a list of available commands`,
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
    // TODO: document that project keys are always uppercased
    console.info(`ZINN - A kanban workflow in the terminal

      usage: zinn [options]
      -h, --help  For help using Zinn`);
  } else {
    const { project, task } = await import("@zinn-dev/core");

    if (FLAG.project.includes(firstArg)) {
      const secondArg = args[1];
      if (secondArg == null) {
        // TODO: implement `zinn project --help` for better guiding
        console.error(
          `The command "${firstArg}" requires a secondary command: zinn ${firstArg} <command>`,
        );
        process.exit(1);
      } else if (FLAG.create.includes(secondArg)) {
        // TODO: allow direct key value pairs with flags like --name and --key
        const projectName = args[2];
        // TODO: maybe auto generate project key from name instead of forcing explicit input (however, very open to collision)
        const projectKey = args[3];

        if (projectName == null || projectKey == null) {
          console.error("Both the project name and the project key must be defined");
          process.exit(1);
        }

        try {
          project.create({ key: projectKey, name: projectName });
        } catch (err) {
          if (err instanceof Error) {
            console.error(err.message);
          } else {
            console.error(err);
          }
          process.exit(1);
        }
      } else if (FLAG.delete.includes(secondArg)) {
        const projectKey = args[2];
        if (projectKey == null) {
          console.error("You need to specificy which project to delete");
          process.exit(1);
        }

        try {
          // TODO: add y/n confirmation
          project.delete(projectKey);
        } catch (err) {
          if (err instanceof Error) {
            console.error(err.message);
          } else {
            console.error(err);
          }

          process.exit(1);
        }
      } else {
        console.error(MESSAGE.displayUnknownCommand(`${firstArg} ${secondArg}`));
        process.exit(1);
      }
    } else if (FLAG.task.includes(firstArg)) {
      const secondArg = args[1];
      if (secondArg == null) {
        // TODO: implement `zinn project --help` for better guiding
        console.error(
          `The command "${firstArg}" requires a secondary command: zinn ${firstArg} <command>`,
        );
        process.exit(1);
      } else if (FLAG.create.includes(secondArg)) {
        const projectKey = args[2];
        if (projectKey == null) {
          console.error("A task needs to belong to a project");
          process.exit(1);
        }

        const taskName = args[3];
        if (taskName == null) {
          console.error("A task needs at least a title");
          process.exit(1);
        }

        const taskDesc = args[4];

        // TODO: do empty strings bypass this check?

        try {
          const standardizedKey = project.standardizeKey(projectKey);
          // TODO: `getByKey` already standardizes the key, but to display it in standardized format, I also used it here. Should it run twice on the same thing?
          const projectMatch = project.getByKey(standardizedKey);
          if (projectMatch == null) {
            console.error(`Project with key "${standardizedKey}" does not exist`);
            process.exit(1);
          }

          // TODO: should it non-null (??) or non-falsy (||) check?
          task.create({
            project_id: projectMatch.id,
            name: taskName,
            description: taskDesc ?? null,
          });
        } catch (err) {
          if (err instanceof Error) {
            console.error(err.message);
          } else {
            console.error(err);
          }
          process.exit(1);
        }
      }
    } else {
      console.error(MESSAGE.displayUnknownCommand(firstArg));
      process.exit(1);
    }
  }
}
