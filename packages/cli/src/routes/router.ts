import type { Command, ParsedRoute, RouteDef } from "../types";

import { quit } from "../lib";

function getIsRunnable(obj: any): obj is Command {
  return Object.hasOwn(obj, "run");
}

function toCommand(args: Array<string>) {
  return args.join(" ");
}

function getNamespaceHelp(parsedRoutes: Array<ParsedRoute>, namespace: string) {
  const prefix = `${namespace} `;
  const commands = parsedRoutes
    .map((route) => route.command)
    .filter((command) => command.startsWith(prefix));

  if (commands.length === 0) {
    return null;
  }

  return `Usage: zinn ${namespace} <command>\n\nCommands:\n${commands.map((command) => `  ${command}`).join("\n")}`;
}

export function parseRoutes(routesDef: RouteDef, prefix?: string) {
  const routeDefinitions: Array<ParsedRoute> = [];
  if (process.env.DEBUG) {
    console.debug(`::router.parseRoutes[${prefix ?? ""}]`, routesDef);
  }

  for (const key of Object.keys(routesDef)) {
    const definition = routesDef[key as keyof typeof routesDef]!;

    const isRunnable = getIsRunnable(definition);
    const combinedRoute = prefix ? `${prefix} ${key}` : key;
    if (isRunnable) {
      routeDefinitions.push({ command: combinedRoute, ...definition });
    } else {
      const result = parseRoutes(definition, combinedRoute);
      routeDefinitions.push(...result);
    }
  }

  return routeDefinitions;
}

function route(parsedRoutes: Array<ParsedRoute>, args: Array<string>) {
  const isHelpRequest = ["-h", "--help"].includes(args.at(-1) ?? "");

  if (isHelpRequest && args.length > 1) {
    const namespace = toCommand(args.slice(0, -1));
    const namespaceHelp = getNamespaceHelp(parsedRoutes, namespace);
    if (namespaceHelp != null) {
      console.info(namespaceHelp);
      return;
    }
  }

  let match: ParsedRoute | null = null;
  let nestingLevel = 0;

  for (let endIndex = args.length; endIndex >= 0; endIndex--) {
    const command = toCommand(args.slice(0, endIndex));
    const matchedRoute = parsedRoutes.find((r) => r.command === command);

    if (matchedRoute) {
      match = matchedRoute;
      nestingLevel = endIndex;
      break;
    }
  }

  if (process.env.DEBUG) {
    console.log("::router.route", { args, result: parsedRoutes.map((r) => r.command), match });
  }

  if (match == null) {
    quit(
      `Unrecognized command "${toCommand(args)}". Please run \`zinn --help\` for a list of available commands`,
    );
  }

  const commandArgs = args.slice(nestingLevel);
  const isCommandHelpRequest =
    commandArgs.length === 1 && ["-h", "--help"].includes(commandArgs[0]!);

  if (isCommandHelpRequest) {
    console.info(match.help);
    return;
  }

  try {
    match.run(commandArgs);
  } catch (err: any) {
    quit(
      err?.message ??
        `Something went wrong while running "${match.command}" with args: ${commandArgs.join(",")}`,
    );
  }
}

export function createRouter(routesDef: RouteDef) {
  const parsedRoutes = parseRoutes(routesDef);

  return { route: (args: Array<string>) => route(parsedRoutes, args) };
}
