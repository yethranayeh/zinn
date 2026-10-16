export type Command = {
  run: (args: Array<string>) => void | Promise<void>;
  help: string;
  // For a flag that is **guessed** rather than what is actually available
  guessedFlags?: Record<string, (args: Array<string>) => Array<string>>;
};
export type ParsedRoute = {
  command: string;
} & Command;

export type RouteDef = { [key: string]: Command | RouteDef };
