import { formatCommand, getOutputMode } from "./lib.js";

type ContinuationToken =
  | { kind: "option"; name: string; rawName: string; value: string | undefined }
  | { kind: "positional" | "option-terminator" };

/** Rebuilds a list command with its existing filters and the next cursor. */
export function formatListContinuation(
  command: Array<string>,
  positionals: Array<string>,
  tokens: Array<ContinuationToken>,
  cursorOption: string,
  cursorId: string,
) {
  const continuation = tokens.flatMap((token) => {
    if (token.kind !== "option" || token.name === cursorOption) {
      return [];
    }

    return [token.value === undefined ? token.rawName : `${token.rawName}=${token.value}`];
  });

  if (getOutputMode() === "json") {
    continuation.push("--json");
  }

  continuation.push(`--${cursorOption}`, cursorId);
  return formatCommand([...command, ...positionals, ...continuation]);
}
