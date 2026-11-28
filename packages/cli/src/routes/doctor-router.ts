import type { DoctorCheck } from "@zinn-dev/core";
import type { Command } from "../types.js";
import type { SkillCopy } from "../skill-copies.js";

import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { doctor } from "@zinn-dev/core";

import { generateCommandUsage, noInput } from "../input.js";
import { output, validatePositionals } from "../lib.js";
import { jsonResult } from "../results.js";
import { formatDoctor, presentDoctor } from "../presentation/doctor-presentation.js";
import { findSkillCopies } from "../skill-copies.js";

const SKILL_INSTALL_COMMAND = "`zinn skill install`";

/** How to replace the differing copies, by where they are */
function skillInstallRemedy(differing: ReadonlyArray<SkillCopy>, workingFolder: string) {
  const hasHomeCopy = differing.some(({ scope }) => scope === "home");
  const hasProjectCopy = differing.some(({ scope }) => scope === "project");
  const projectCommand = `\`zinn skill install --project\` run in ${workingFolder}`;

  if (hasHomeCopy && hasProjectCopy) {
    return `Update the skill with ${SKILL_INSTALL_COMMAND}, and with ${projectCommand}`;
  }

  return `Update the skill with ${hasProjectCopy ? projectCommand : SKILL_INSTALL_COMMAND}`;
}

/** What is wrong with one differing copy */
function describeDifference({ readable, reviewedVersion }: SkillCopy) {
  if (!readable) {
    return "cannot be read";
  }

  return reviewedVersion === null
    ? "names no reviewed CLI version"
    : `was reviewed for CLI ${reviewedVersion}`;
}

function checkAgentSkill(): DoctorCheck<"agent_skill"> {
  const workingFolder = process.cwd();
  const { bundledVersion, copies } = findSkillCopies(homedir(), workingFolder);

  if (copies.length === 0) {
    return {
      id: "agent_skill",
      status: "ok",
      message: "No Zinn skill is installed for agents",
      remedy: null,
    };
  }

  const differing = copies.filter(({ matches }) => !matches);

  if (differing.length === 0) {
    return {
      id: "agent_skill",
      status: "ok",
      message: `The installed Zinn skill matches the one this CLI installs (reviewed for CLI ${bundledVersion})`,
      remedy: null,
    };
  }

  const [first, ...others] = differing.map((copy) => `at ${copy.path} ${describeDifference(copy)}`);
  const differences = [
    `The installed Zinn skill ${first}`,
    ...others.map((difference) => `the one ${difference}`),
  ];
  const isOnlyUnreadable = differing.every(({ readable }) => !readable);

  if (!isOnlyUnreadable) {
    differences.push(`and the skill this CLI installs was reviewed for CLI ${bundledVersion}`);
  }

  return {
    id: "agent_skill",
    status: "warning",
    message: differences.join(", "),
    remedy: skillInstallRemedy(differing, workingFolder),
  };
}

export const doctorCommand = {
  summary: "Check the selected settings, database and installed agent skill for problems.",
  effects: { domain: "none", storage: "inspect", external: [] },
  confirmation: { kind: "none" },
  input: noInput,
  results: [{ ...jsonResult("Doctor"), findingsExitCode: 1 }],
  run: (args) => {
    const { positionals } = parseArgs({
      options: noInput.options,
      args,
      strict: true,
      allowPositionals: true,
    });
    validatePositionals(positionals, noInput.forms[0]);
    const report = presentDoctor(doctor.check(), checkAgentSkill());
    output(report, formatDoctor);

    if (!report.ok) {
      process.exitCode = 1;
    }
  },
  help: `${generateCommandUsage("doctor", noInput)}

Check the selected settings, store folder, database, search index and the Zinn agent skill copies in the home and working folders for problems, and suggest a fix for each.

Exits 0 when every check is ok and 1 when any reports a warning or problem. The checks print on standard output either way.
Changes nothing: it creates no folder, database or settings file, and repairs nothing. SQLite may perform its normal file housekeeping.`,
} satisfies Command;
