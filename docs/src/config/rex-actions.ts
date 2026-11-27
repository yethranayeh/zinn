import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The docs build and its tests run from docs/, while other tests run from the repository root.
const actionRoots = ["../integrations/rex/zinn", "integrations/rex/zinn"];
const versionLine = /^local version = "([^"]+)"$/m;

/** The actions' version, read from the cli.lua that zinn.sh serves. */
function readActionsVersion(): string {
  for (const root of actionRoots) {
    const path = join(process.cwd(), root, "cli.lua");
    if (!existsSync(path)) {
      continue;
    }

    const version = versionLine.exec(readFileSync(path, "utf8"))?.[1];
    if (version === undefined) {
      throw new Error(`${path} has no version line`);
    }

    return version;
  }

  throw new Error(`No integrations/rex/zinn/cli.lua under ${process.cwd()}`);
}

export const rexActions = {
  title: "Zinn actions for Rex",
  description:
    "Rex palette actions that file a new Zinn task, paste a Zinn task into the program in a pane, and resume the agent conversation that changed a task: requirements, installation, key bindings and calls to Zinn.",
  path: "/integrations/rex/actions",
  version: readActionsVersion(),
  versionCheck: 'require("zinn").version',
  changelog: "/changelog",
  site: "https://www.superlogical.com/rex",
  configDocs: "https://www.superlogical.com/rex/docs/customize/config#file-location",
  introduction:
    "Three palette actions for Rex. Zinn: New task files a task. Zinn: Insert task pastes one into the program in the pane. Zinn: Resume session opens the agent conversation that changed one.",
  // The action files, served from `downloadBase`. Every .lua file in integrations/rex/zinn is listed here.
  files: [
    "init.lua",
    "cli.lua",
    "notify.lua",
    "task_picker.lua",
    "new_task.lua",
    "insert_task.lua",
    "resume_session.lua",
  ],
  downloadBase: "/integrations/rex/actions/zinn",
  commands: [
    'curl -fsSL --create-dirs "https://zinn.sh/integrations/rex/actions/zinn/{init,cli,notify,task_picker,new_task,insert_task,resume_session}.lua" -o "${XDG_CONFIG_HOME:-$HOME/.config}/rex/zinn/#1.lua"',
  ],
  windowsCommand:
    'curl -fsSL https://codeload.github.com/yethranayeh/zinn/tar.gz/main | tar -xz -C "%AppData%\\rex" --strip-components=3 zinn-main/integrations/rex/zinn',
  require: 'require("zinn")',
  reload: "rex config reload",
  bindings: [
    'rex.bind("cmd+alt+n", "zinn_new_task")',
    'rex.bind("cmd+i", "zinn_insert_task")',
    'rex.bind("cmd+alt+r", "zinn_resume_session")',
  ],
  projectBinding: 'rex.bind("cmd+alt+n", "zinn_new_task", { project = "WEB" })',
  scriptCommand: 'rex do zinn_new_task title="Fix the login" project=WEB',
  taskBinding: 'rex.bind("cmd+alt+i", "zinn_insert_task", { task = "WEB-12" })',
};
