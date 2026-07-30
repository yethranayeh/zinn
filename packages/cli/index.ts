#!/usr/bin/env bun
import { getArgs, quit } from "./src/lib";

const args = getArgs();
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
    quit("Direct launch in a non-TTY environment is not supported.");
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
        quit(`The command "${firstArg}" requires a secondary command: zinn ${firstArg} <command>`);
      } else if (FLAG.create.includes(secondArg)) {
        // TODO: allow direct key value pairs with flags like --name and --key
        const projectName = args[2];
        // TODO: maybe auto generate project key from name instead of forcing explicit input (however, very open to collision)
        const projectKey = args[3];

        if (projectName == null || projectKey == null) {
          quit("Both the project name and the project key must be defined");
        }

        try {
          project.create({ key: projectKey, name: projectName });
        } catch (err: any) {
          quit(err?.message ?? "Something went wrong");
        }
      } else if (FLAG.delete.includes(secondArg)) {
        const projectKey = args[2];
        if (projectKey == null) {
          quit("You need to specificy which project to delete");
        }

        try {
          // TODO: add y/n confirmation
          project.delete(projectKey);
        } catch (err: any) {
          quit(err?.message ?? "Something went wrong");
        }
      } else {
        quit(MESSAGE.displayUnknownCommand(`${firstArg} ${secondArg}`));
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
          quit("A task needs to belong to a project");
        }

        const taskName = args[3];
        if (taskName == null) {
          quit("A task needs at least a title");
        }

        const taskDesc = args[4];

        // TODO: do empty strings bypass this check?

        try {
          const standardizedKey = project.standardizeKey(projectKey);
          // TODO: `getByKey` already standardizes the key, but to display it in standardized format, I also used it here. Should it run twice on the same thing?
          const projectMatch = project.getByKey(standardizedKey);
          if (projectMatch == null) {
            quit(`Project with key "${standardizedKey}" does not exist`);
          }

          // TODO: should it non-null (??) or non-falsy (||) check?
          task.create({
            project_id: projectMatch.id,
            name: taskName,
            description: taskDesc ?? null,
          });
        } catch (err: any) {
          quit(err?.message ?? "Something went wrong");
        }
      }
    } else {
      quit(MESSAGE.displayUnknownCommand(firstArg));
    }
  }
}
