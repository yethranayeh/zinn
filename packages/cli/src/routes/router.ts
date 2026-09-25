import type { Command, ParsedRoute, RouteDef } from "../types";

import { isHelpFlag, isJsonFlag, quit, setOutputMode } from "../lib";

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
    .filter((command) => command.startsWith(prefix))
    .map((command) => command.slice(prefix.length));

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

function route(parsedRoutes: Array<ParsedRoute>, rawArgs: Array<string>) {
  // Anything after "--" belongs to the command, so "--json" there is search text, not a flag.
  const separatorIndex = rawArgs.indexOf("--");
  const routableArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
  const passthroughArgs = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex);
  const filteredRoutableArgs = routableArgs.filter((arg) => !isJsonFlag(arg));

  if (filteredRoutableArgs.length !== routableArgs.length) {
    setOutputMode("json");
  }

  const args = [...filteredRoutableArgs, ...passthroughArgs];
  const isHelpRequest = isHelpFlag(filteredRoutableArgs.at(-1) ?? "");

  if (isHelpRequest && args.length > 1) {
    const namespace = toCommand(filteredRoutableArgs.slice(0, -1));
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
  const isCommandHelpRequest = commandArgs.length === 1 && isHelpFlag(commandArgs[0]!);

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
