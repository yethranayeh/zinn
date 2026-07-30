export type Command = { run: Function; help: string };
export type Route = {
  command: string;
} & Command;

// TODO: proper route typing
export type RouteDef = Object;
