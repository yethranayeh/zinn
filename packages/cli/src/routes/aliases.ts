export const commandAliases: Record<string, readonly string[]> = {
  view: ["show"],
  list: ["ls"],
  delete: ["rm"],
  create: ["new"],
};

export function getCommandAliases(command: string): Array<Array<string>> {
  const words = command.split(" ");
  const name = words.pop()!;

  return (commandAliases[name] ?? []).map((alias) => [...words, alias]);
}
