import type { PresentedSkillInstall } from "../result-schemas.js";
import type { RouteDef } from "../types.js";
import type { StdioOptions } from "node:child_process";
import type { CommandInput } from "../input.js";

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

import { CliError } from "../errors.js";

import { generateCommandUsage } from "../input.js";
import {
  diagnostic,
  getOutputMode,
  output,
  validatePositionals,
  validateUniqueOptions,
} from "../lib.js";
import { jsonResult } from "../results.js";
import { bundledSkillDirectory } from "../skill-copies.js";

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

const skillInputs = {
  install: {
    options: { project: { type: "boolean" } },
    forms: [{ id: "default", positionals: [] }],
    constraints: [],
  },
} as const satisfies Record<string, CommandInput>;

/**
 * Runs the skills CLI in the current working directory and resolves with its exit code
 * If a signal ends it, it's `null`
 */
function runSkillsCli(skillDirectory: string, isProject: boolean): Promise<number | null> {
  const isJson = getOutputMode() === "json";
  // JSON output keeps stdout for the result and stderr for one error document,
  // so the skills CLI's output is captured and reported as notices.
  // Without -g the skills CLI installs into the current folder.
  const scopeArgs = isProject ? [] : ["-g"];
  const child = startNpx(
    ["--yes", "skills", "add", skillDirectory, ...scopeArgs, "-y"],
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
    input: skillInputs.install,
    results: [jsonResult("SkillInstall")],
    run: async (args) => {
      const { positionals, values, tokens } = parseArgs({
        options: skillInputs.install.options,
        args,
        strict: true,
        allowPositionals: true,
        tokens: true,
      });

      validateUniqueOptions(tokens, skillInputs.install.options);
      validatePositionals(positionals, skillInputs.install.forms[0]);

      const exitCode = await runSkillsCli(bundledSkillDirectory, values.project === true);

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
    help: `${generateCommandUsage("skill install", skillInputs.install)}

Install the agent skill bundled with this CLI using the skills CLI (https://github.com/vercel-labs/skills).

Runs npx --yes skills add <skill folder> -g -y, where the skill folder is the one inside this CLI's package, and passes the skills CLI's output and exit code through.
Use --project to install into the current folder instead. It runs the same command without -g there, and the skills CLI records the copy in that folder's skills-lock.json.
Rerun it after upgrading Zinn, or run npx skills update -g, which reads the same folder. Each project with its own copy needs zinn skill install --project rerun there after an upgrade.
With --json, the skills CLI's output is reported as notices: on stderr after the result, or in error.diagnostics when it fails.`,
  },
} satisfies RouteDef;
