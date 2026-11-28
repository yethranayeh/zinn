import type { PresentedSkillInstall } from "../result-schemas.js";
import type { RouteDef } from "../types.js";
import type { StdioOptions } from "node:child_process";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CliError } from "../errors.js";
import { generateCommandUsage, noInput } from "../input.js";
import { diagnostic, getOutputMode, output, validatePositionals } from "../lib.js";
import { jsonResult } from "../results.js";

/** The workflow skill folder that ships with the CLI */
export const bundledSkillDirectory = fileURLToPath(new URL("../../skills/zinn", import.meta.url));
/** On Windows npx is `npx.cmd`, which Node only starts through a shell */
const needsShell = process.platform === "win32";

/** Starts npx with one argument per array item, or on Windows as one command line for the shell */
function startNpx(args: Array<string>, stdio: StdioOptions) {
  if (needsShell) {
    // Node warns when an argument array is combined with a shell (DEP0190), so the line is built here.
    // Windows paths cannot contain double quotes, so quoting each argument keeps spaces inside it.
    const commandLine = ["npx", ...args.map((arg) => `"${arg}"`)].join(" ");
    return spawn(commandLine, { stdio, shell: true });
  }

  return spawn("npx", args, { stdio });
}

/**
 * Runs the skills CLI and resolves with its exit code
 * If a signal ends it, it's `null`
 */
function runSkillsCli(skillDirectory: string): Promise<number | null> {
  const isJson = getOutputMode() === "json";
  // JSON output keeps stdout for the result and stderr for one error document,
  // so the skills CLI's output is captured and reported as notices.
  const child = startNpx(
    ["--yes", "skills", "add", skillDirectory, "-g", "-y"],
    ["inherit", isJson ? "pipe" : "inherit", isJson ? "pipe" : "inherit"],
  );
  const captured: Array<string> = [];
  // Decoding per stream keeps a character whose bytes arrive in two chunks intact.
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (text: string) => captured.push(text));
  }

  return new Promise((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        const message = "npx was not found. zinn skill install needs npx, which comes with npm.";
        reject(new CliError(message, "not_found", undefined, undefined, undefined, error));
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => {
      const lines = captured
        .join("")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      for (const line of lines) {
        diagnostic(line);
      }
      resolve(code);
    });
  });
}

export const skillRouter = {
  install: {
    summary: "Install the agent skill bundled with this CLI using the skills CLI.",
    effects: { domain: "none", storage: "none", external: ["files", "network"] },
    confirmation: { kind: "none" },
    input: noInput,
    results: [jsonResult("SkillInstall")],
    run: async (args) => {
      const { positionals } = parseArgs({
        options: noInput.options,
        args,
        strict: true,
        allowPositionals: true,
      });

      validatePositionals(positionals, noInput.forms[0]);

      const exitCode = await runSkillsCli(bundledSkillDirectory);

      if (exitCode !== 0) {
        const endedBySignal = exitCode === null;
        const failure = new CliError(
          endedBySignal
            ? "The skills CLI was stopped."
            : `The skills CLI exited with code ${exitCode}.`,
          "internal",
          { path: bundledSkillDirectory, ...(endedBySignal ? {} : { exitCode }) },
        );

        if (!endedBySignal) {
          failure.exitCode = exitCode;
        }

        throw failure;
      }

      const installed: PresentedSkillInstall = { source: bundledSkillDirectory };
      output(installed, () => "");
    },
    help: `${generateCommandUsage("skill install", noInput)}

Install the agent skill bundled with this CLI using the skills CLI (https://github.com/vercel-labs/skills).

Runs npx --yes skills add <skill folder> -g -y, where the skill folder is the one inside this CLI's package, and passes the skills CLI's output and exit code through.
Rerun it after upgrading Zinn, or run npx skills update -g, which reads the same folder.
With --json, the skills CLI's output is reported as notices: on stderr after the result, or in error.diagnostics when it fails.`,
  },
} satisfies RouteDef;
