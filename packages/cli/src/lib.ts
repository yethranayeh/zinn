import type { parseArgs } from "node:util";

type ParsedTokens = NonNullable<ReturnType<typeof parseArgs>["tokens"]>;
type OutputMode = "text" | "json";

let outputMode: OutputMode = "text";

export function setOutputMode(mode: OutputMode) {
  outputMode = mode;
}

export function isJsonFlag(flag: string) {
  return flag === "--json";
}

export function output<T>(data: T, transformToString: (data: T) => string) {
  if (outputMode === "json") {
    console.info(JSON.stringify(data, null, 2));
    return;
  }

  const dataText = transformToString(data);

  if (dataText.length > 0) {
    console.info(dataText);
  }
}

export function confirmAction(message: string) {
  if (outputMode === "json") {
    // FIXME: confirmations currently break JSON outputs with jq parse error
    quit("Commands that ask for confirmation cannot be used with --json yet");
  }

  return confirm(message);
}

export function quit(reason: string): never {
  if (outputMode === "json") {
    console.error(JSON.stringify({ error: { message: reason } }, null, 2));
  } else {
    console.error(reason);
  }

  process.exit(1);
}

export function validatePositionalCount(
  positionals: Array<string>,
  expected: number,
  message: string,
) {
  if (positionals.length !== expected) {
    quit(message);
  }
}

export function validateUniqueOptions(tokens: ParsedTokens, repeatableOptions: Array<string> = []) {
  const parsedArgs = new Set<string>();

  for (const token of tokens) {
    if (token.kind !== "option") {
      continue;
    }

    const isRepeatable = repeatableOptions.includes(token.name);
    if (parsedArgs.has(token.name) && !isRepeatable) {
      quit(`Option "--${token.name}" can only be specified once`);
    }

    parsedArgs.add(token.name);
  }
}

export function isHelpFlag(flag: string) {
  return ["-h", "--help"].includes(flag);
}
