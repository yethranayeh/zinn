import type { Command, Route, RouteDef } from "../types";

import { getArgs, quit } from "../lib";

import { routes } from "./routes";

function getIsRunnable(obj: any): obj is Command {
  return Object.hasOwn(obj, "run");
}

function toCommand(args: Array<string>) {
  return args.join(" ");
}

export function parseRoutes(routesDef: RouteDef, prefix?: string) {
  const routeDefinitions: Array<Route> = [];
  if (process.env.DEBUG) {
    console.debug(`::router.parseRoutes[${prefix ?? ""}]`, routesDef);
  }

  for (const key of Object.keys(routesDef)) {
    const definition = routesDef[key as keyof typeof routesDef];

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

export function route(args: Array<string>) {
  const parsedRoutes = parseRoutes(routes);
  let match: Route | null = null;
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

  try {
    match.run(getArgs(nestingLevel));
  } catch (err: any) {
    quit(
      err?.message ??
        `Something went wrong while running "${match.command}" with args: ${getArgs(nestingLevel).join(",")}`,
    );
  }
}
