export const rexActions = {
  title: "Zinn actions for Rex",
  description:
    "Rex palette actions that file a new Zinn task and paste a Zinn task into the program in a pane: requirements, installation, key bindings and calls to Zinn.",
  path: "/integrations/rex/actions",
  site: "https://www.superlogical.com/rex",
  configDocs: "https://www.superlogical.com/rex/docs/customize/config#file-location",
  introduction:
    "Two palette actions for Rex. Zinn: New task files a task. Zinn: Insert task pastes one into the program in the pane.",
  // The action files, served from `downloadBase`. Every .lua file in integrations/rex/zinn is listed here.
  files: ["init.lua", "cli.lua", "notify.lua", "new_task.lua", "insert_task.lua"],
  downloadBase: "/integrations/rex/actions/zinn",
  commands: [
    'curl -fsSL --create-dirs "https://zinn.sh/integrations/rex/actions/zinn/{init,cli,notify,new_task,insert_task}.lua" -o "${XDG_CONFIG_HOME:-$HOME/.config}/rex/zinn/#1.lua"',
  ],
  windowsCommand:
    'curl -fsSL https://codeload.github.com/yethranayeh/zinn/tar.gz/main | tar -xz -C "%AppData%\\rex" --strip-components=3 zinn-main/integrations/rex/zinn',
  require: 'require("zinn")',
  reload: "rex config reload",
  bindings: ['rex.bind("cmd+alt+n", "zinn_new_task")', 'rex.bind("cmd+i", "zinn_insert_task")'],
  projectBinding: 'rex.bind("cmd+alt+n", "zinn_new_task", { project = "WEB" })',
  scriptCommand: 'rex do zinn_new_task title="Fix the login" project=WEB',
  taskBinding: 'rex.bind("cmd+alt+i", "zinn_insert_task", { task = "WEB-12" })',
};
