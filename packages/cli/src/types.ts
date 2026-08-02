export type Command = { run: (args: Array<string>) => void; help: string };
export type ParsedRoute = {
  command: string;
} & Command;

export type RouteDef = { [key: string]: Command | RouteDef };
