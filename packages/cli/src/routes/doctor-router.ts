import type { DoctorCheck } from "@zinn-dev/core";
import type { Command } from "../types.js";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { doctor, isMissingFileError } from "@zinn-dev/core";

import { generateCommandUsage, noInput } from "../input.js";
import { output, validatePositionals } from "../lib.js";
import { jsonResult } from "../results.js";
import { formatDoctor, presentDoctor } from "../presentation/doctor-presentation.js";
import { bundledSkillDirectory } from "./skill-router.js";

/** Where the `skills` CLI installs the Zinn workflow skill, inside the home folder */
const INSTALLED_SKILL_PATH = [".agents", "skills", "zinn", "SKILL.md"];
const SKILL_FILE_NAME = "SKILL.md";
const SKILL_INSTALL_REMEDY = "Update the skill with `zinn skill install`";
/** The YAML frontmatter block that opens a skill file */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/**
 * The reviewed version under the frontmatter's `metadata:`
 *  map, quoted or plain
 */
const REVIEWED_VERSION_PATTERN =
  /^metadata:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+zinn-cli-reviewed-version:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#'"]+))/m;

/** A skill file's reviewed CLI version, `null` when the file has none that can be read */
function readReviewedVersion(skill: string) {
  const frontmatter = FRONTMATTER_PATTERN.exec(skill)?.[1];

  if (frontmatter === undefined) {
    return null;
  }

  const match = REVIEWED_VERSION_PATTERN.exec(frontmatter);

  if (match === null) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function checkAgentSkill(): DoctorCheck<"agent_skill"> {
  const path = join(homedir(), ...INSTALLED_SKILL_PATH);
  let skill: string;

  try {
    skill = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        id: "agent_skill",
        status: "ok",
        message: "No Zinn skill is installed for agents",
        remedy: null,
      };
    }

    return {
      id: "agent_skill",
      status: "warning",
      message: `The installed Zinn skill at ${path} cannot be read`,
      remedy: SKILL_INSTALL_REMEDY,
    };
  }

  const reviewedVersion = readReviewedVersion(skill);
  // The skill `zinn skill install` installs. It ships with the CLI, and release checks guarantee its version.
  const bundledVersion = readReviewedVersion(
    readFileSync(join(bundledSkillDirectory, SKILL_FILE_NAME), "utf8"),
  );

  if (reviewedVersion !== null && reviewedVersion === bundledVersion) {
    return {
      id: "agent_skill",
      status: "ok",
      message: `The installed Zinn skill matches the one this CLI installs (reviewed for CLI ${bundledVersion})`,
      remedy: null,
    };
  }

  const found =
    reviewedVersion === null
      ? "names no reviewed CLI version"
      : `was reviewed for CLI ${reviewedVersion}`;
  return {
    id: "agent_skill",
    status: "warning",
    message: `The installed Zinn skill at ${path} ${found}, and the skill this CLI installs was reviewed for CLI ${bundledVersion}`,
    remedy: SKILL_INSTALL_REMEDY,
  };
}

export const doctorCommand = {
  summary: "Check the selected settings, database and installed agent skill for problems.",
  effects: { domain: "none", storage: "inspect" },
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

Check the selected settings, store folder, database, search index and installed agent skill for problems, and suggest a fix for each.

Exits 0 when every check is ok and 1 when any reports a warning or problem. The checks print on standard output either way.
Changes nothing: it creates no folder, database or settings file, and repairs nothing. SQLite may perform its normal file housekeeping.`,
} satisfies Command;
