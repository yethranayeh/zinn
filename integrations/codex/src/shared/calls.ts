import { basename, resolve } from "node:path";

import { segments, redactArgv } from "./shell";

export type Call = {
  argv: string[];
  store: string | null;
  cwd: string | null;
  storeKnown: boolean;
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["command", "exec", "time", "nohup", "env"]);

// Parse direct shell calls without evaluating expansions or embedded programs.
export function calls(
  command: string,
  cli: readonly string[],
  cwd: string | null,
  inheritedStore: string | null,
): Array<Call> {
  const found: Array<Call> = [];
  let effectiveCwd = cwd;
  let inheritedStoreKnown = true;

  for (const words of segments(command)) {
    let index = 0;
    let store = inheritedStore;
    let storeKnown = inheritedStoreKnown;

    while (index < words.length) {
      const word = words[index]!;

      if (ASSIGNMENT.test(word)) {
        if (word.startsWith("ZINN_DIR=")) {
          store = word.slice("ZINN_DIR=".length);
          storeKnown = !/[$`~]/.test(store);
          if (storeKnown && effectiveCwd !== null && store !== "") {
            store = resolve(effectiveCwd, store);
          }
          if (store === "") {
            storeKnown = false;
          }
        }
        index++;
        continue;
      }

      if (WRAPPERS.has(word)) {
        index++;
        continue;
      }

      break;
    }

    const executable = words[index];
    if (executable === "cd") {
      // Shell control flow does not prove that a directory change succeeded.
      effectiveCwd = null;
      continue;
    }

    // Export and unset make later subprocess store selection uncertain.
    if (
      (executable === "export" || executable === "unset") &&
      words.some((word) => word === "ZINN_DIR" || word.startsWith("ZINN_DIR="))
    ) {
      inheritedStoreKnown = false;
      continue;
    }

    const isZinn = executable !== undefined && basename(executable) === "zinn";
    const isConfigured =
      cli.length > 0 &&
      cli.every((expected, offset) => {
        const word = words[index + offset];
        return (
          word !== undefined &&
          !/[$`]/.test(word) &&
          (word === expected ||
            (effectiveCwd !== null &&
              expected.startsWith("/") &&
              resolve(effectiveCwd, word) === expected))
        );
      });

    if (isZinn || isConfigured) {
      found.push({
        argv: redactArgv(words.slice(index + (isZinn ? 1 : cli.length))),
        store,
        cwd: effectiveCwd,
        storeKnown,
      });
    }
  }

  return found;
}
