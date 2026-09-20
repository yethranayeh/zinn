import type { parseArgs } from "node:util";

type ParsedTokens = NonNullable<ReturnType<typeof parseArgs>["tokens"]>;

export function quit(reason: string): never {
  console.error(reason);
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
