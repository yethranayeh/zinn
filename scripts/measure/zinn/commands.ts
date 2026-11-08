/** The command set measured against one fixture copy. */

export type CommandSpec = {
  name: string;
  args: readonly string[];
};

/** The 40-character title used for the create command. */
export const CREATE_TITLE = "insinking copleased rutinose stoach sari";

export const MEASURED_COMMANDS: readonly CommandSpec[] = [
  { name: "list", args: ["task", "list", "BNCH"] },
  { name: "list-json", args: ["task", "list", "BNCH", "--json"] },
  { name: "view", args: ["task", "view", "BNCH-50"] },
  { name: "create", args: ["task", "create", "BNCH", "--title", CREATE_TITLE] },
  { name: "move", args: ["task", "move", "BNCH-50", "TODO"] },
  { name: "search", args: ["task", "search", "amarillo", "BNCH"] },
  { name: "backup", args: ["backup"] },
];

export const COMMAND_NAMES: readonly string[] = MEASURED_COMMANDS.map((command) => command.name);

/** Returns the named commands in definition order, so a subset keeps the table stable. */
export function selectCommands(names: readonly string[]): CommandSpec[] {
  const selected = new Set(names);
  return MEASURED_COMMANDS.filter((command) => selected.has(command.name));
}

export type StartupCommand = {
  name: string;
  /** Arguments after the program, without the CLI entry point for a plain node run. */
  args: readonly string[];
  nodeOnly: boolean;
};

export const STARTUP_COMMANDS: readonly StartupCommand[] = [
  { name: "node -e 0", args: ["-e", "0"], nodeOnly: true },
  { name: "zinn --version", args: ["--version"], nodeOnly: false },
];
