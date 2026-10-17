import type { Command, ParsedRoute, RouteDef } from "../types.js";

import { parseArgs } from "node:util";

import {
  dashValueHelp,
  diagnostic,
  flushDiagnostics,
  isAllowLegacyReadFlag,
  isHelpFlag,
  isRouterFlag,
  parseArgsMessage,
  prepareOutput,
  quit,
  renderFailure,
  setLegacyReadAllowed,
  UsageError,
  validateUniqueOptions,
} from "../lib.js";

// ZINN_DEBUG=1 prints routing detail on stderr, so stdout and `--json` results stay unchanged.
function isDebugOutputEnabled() {
  return process.env.ZINN_DEBUG === "1";
}

function getIsRunnable(obj: any): obj is Command {
  return Object.hasOwn(obj, "run");
}

// --json and --allow-legacy-read can each be given once, like a command's own flags.
function validateRouterFlags(routableArgs: Array<string>) {
  const { tokens } = parseArgs({
    args: routableArgs.filter(isRouterFlag),
    options: { json: { type: "boolean" }, "allow-legacy-read": { type: "boolean" } },
    strict: true,
    tokens: true,
  });

  validateUniqueOptions(tokens);
}

/** The usage lines that open a command's help, up to its first blank line. */
function getUsage(help: string) {
  return help.split("\n\n")[0]!;
}

function toCommand(args: Array<string>) {
  return args.join(" ");
}

// Groups sibling commands into one line, e.g. "  comment {create|list|edit|delete}".
// A command without siblings is not a choice, so it gets no braces, e.g. "  backup".
// Top-level commands in the root help are unrelated to each other, so each gets its own line.
function formatCommands(parsedRoutes: Array<ParsedRoute>, prefix: string) {
  const isRootHelp = prefix === "";
  const siblingsByParent = new Map<string, Array<string>>();
  for (const { command } of parsedRoutes) {
    if (!command.startsWith(prefix)) {
      continue;
    }

    const words = command.slice(prefix.length).split(" ");
    const parent = toCommand(words.slice(0, -1));
    siblingsByParent.set(parent, [...(siblingsByParent.get(parent) ?? []), words.at(-1)!]);
  }

  return [...siblingsByParent]
    .flatMap(([parent, siblings]) => {
      const isTopLevel = isRootHelp && parent === "";
      if (isTopLevel) {
        return siblings.map((command) => `  ${command}`);
      }

      const commands = siblings.length === 1 ? siblings[0] : `{${siblings.join("|")}}`;
      return [`  ${parent === "" ? "" : `${parent} `}${commands}`];
    })
    .join("\n");
}

function getRootHelp(parsedRoutes: Array<ParsedRoute>) {
  // TODO: maybe "brand" text that is exported and used here for title and desc
  return `ZINN - A kanban workflow in the terminal

Usage: zinn <command>

Options:
  -h, --help  Show help
  -v, --version  Show version
  --json      Print command output as JSON
  --allow-legacy-read  Read a database without a schema version, best effort and read-only

Commands:
${formatCommands(parsedRoutes, "")}

Run zinn <namespace> --help or zinn <command> --help for more information.
--help shows help for the command words before it and runs nothing. The rest of the line is ignored.
-- ends the options: everything after it is considered a plain word, even if it starts with a dash (e.g. 'zinn project column create SHOP -- -later').
Flags after it are not read.
${dashValueHelp("--description")}
Running zinn without a command shows this help.`;
}

function getNamespaceHelp(parsedRoutes: Array<ParsedRoute>, namespace: string) {
  const commands = formatCommands(parsedRoutes, `${namespace} `);

  if (commands === "") {
    return null;
  }

  return `Usage: zinn ${namespace} <command>\n\nCommands:\n${commands}`;
}

// The longest leading run of words that names a namespace, or the root namespace "" when none does.
function findNearestNamespace(parsedRoutes: Array<ParsedRoute>, words: Array<string>) {
  for (let endIndex = words.length; endIndex > 0; endIndex--) {
    const namespace = toCommand(words.slice(0, endIndex));
    const help = getNamespaceHelp(parsedRoutes, namespace);

    if (help != null) {
      return { namespace, wordCount: endIndex, help };
    }
  }

  return { namespace: "", wordCount: 0, help: getRootHelp(parsedRoutes) };
}

// Prints help for a namespace when asked, or exits with an error for a missing or unknown command in it.
function routeToNamespace(
  parsedRoutes: Array<ParsedRoute>,
  words: Array<string>,
  isHelpRequest: boolean,
) {
  const { namespace, wordCount, help } = findNearestNamespace(parsedRoutes, words);
  const unknownWord = words[wordCount];
  const commandName = namespace === "" ? "zinn" : `zinn ${namespace}`;

  if (unknownWord == null && isHelpRequest) {
    console.info(help);
    return;
  }

  if (unknownWord == null) {
    quit(`Missing a command for "${commandName}"`, help, { argument: "command" });
  }

  const reason = `Unrecognized command "${unknownWord}" for "${commandName}"`;

  if (isHelpRequest) {
    quit(reason, help, { argument: "command" });
  }

  quit(`${reason}. Run \`${commandName} --help\` for a list of available commands`, undefined, {
    argument: "command",
  });
}

export function parseRoutes(routesDef: RouteDef, prefix?: string) {
  const routeDefinitions: Array<ParsedRoute> = [];
  if (isDebugOutputEnabled()) {
    diagnostic(`::router.parseRoutes[${prefix ?? ""}] ${Object.keys(routesDef).join(" ")}`);
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

async function route(parsedRoutes: Array<ParsedRoute>, rawArgs: Array<string>) {
  prepareOutput(rawArgs);
  // Anything after "--" belongs to the command, so "--json" there is search text, not a flag.
  const separatorIndex = rawArgs.indexOf("--");
  const routableArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
  const passthroughArgs = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex);
  const filteredRoutableArgs = routableArgs.filter((arg) => !isRouterFlag(arg));

  if (routableArgs.some(isAllowLegacyReadFlag)) {
    setLegacyReadAllowed(true);
  }

  // A help flag asks for help with the command words before it, so nothing after it is read.
  const helpFlagIndex = filteredRoutableArgs.findIndex(isHelpFlag);
  const isHelpRequest = helpFlagIndex !== -1;
  const args = isHelpRequest
    ? filteredRoutableArgs.slice(0, helpFlagIndex)
    : [...filteredRoutableArgs, ...passthroughArgs];

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

  if (isDebugOutputEnabled()) {
    diagnostic(`::router.route ${match?.command ?? "namespace"}`);
  }

  if (match == null) {
    routeToNamespace(parsedRoutes, args, isHelpRequest);
    return;
  }

  if (isHelpRequest) {
    console.info(match.help);
    return;
  }

  validateRouterFlags(routableArgs);

  const commandArgs = args.slice(nestingLevel);

  try {
    await match.run(commandArgs);
  } catch (err: any) {
    if (err instanceof UsageError) {
      err.help = getUsage(match.help);
      throw err;
    }

    const suggestFor = (flag: string) => match.guessedFlags?.[flag]?.(commandArgs);
    const parseArgsReason = parseArgsMessage(err, rawArgs, suggestFor);
    if (parseArgsReason != null) {
      const argument = /(?:Unknown option|Option) '(-[^' ]+)/.exec(err.message)?.[1];

      quit(
        parseArgsReason,
        getUsage(match.help),
        argument === undefined ? undefined : { argument },
      );
    }

    throw err;
  }
}

export function createRouter(routesDef: RouteDef) {
  const parsedRoutes = parseRoutes(routesDef);

  return {
    route: async (args: Array<string>) => {
      try {
        await route(parsedRoutes, args);
        flushDiagnostics();
      } catch (error) {
        renderFailure(error);
      }
    },
    help: getRootHelp(parsedRoutes),
  };
}
