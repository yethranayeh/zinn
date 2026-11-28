import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMissingFileError } from "@zinn-dev/core";

/** The workflow skill folder that ships with the CLI */
export const bundledSkillDirectory = fileURLToPath(new URL("../skills/zinn", import.meta.url));

const SKILL_FILE_NAME = "SKILL.md";
/** The YAML frontmatter block that opens a skill file */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/**
 * The reviewed version under the frontmatter's `metadata:`
 *  map, quoted or plain
 */
const REVIEWED_VERSION_PATTERN =
  /^metadata:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+zinn-cli-reviewed-version:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#'"]+))/m;

export type SkillCopyScope = "home" | "project";

/** A single Zinn skill file an agent can load, seen via every path that resolves to it */
export type SkillCopy = {
  /** First checked path that resolves to this file */
  path: string;
  realPath: string;
  /** Where this copy lives (e.g. project, user, or bundled) */
  scope: SkillCopyScope;
  /** False when the file exists on disk but could not be read */
  readable: boolean;
  reviewedVersion: string | null;
  /** Whether its reviewed version matches the bundled skill */
  matches: boolean;
};

export type SkillCopies = {
  /** The reviewed version of the skill `zinn skill install` installs */
  bundledVersion: string | null;
  copies: Array<SkillCopy>;
};

/**
 * Agent skill folders in lookup order.
 *
 * OpenCode prefers project `.agents/skills` over home directory,
 *  whereas Claude Code prefers home `.claude/skills` over project.
 */
const SKILL_BASES: ReadonlyArray<{ scope: SkillCopyScope; segments: ReadonlyArray<string> }> = [
  { scope: "home", segments: [".agents", "skills"] },
  { scope: "home", segments: [".claude", "skills"] },
  { scope: "project", segments: [".agents", "skills"] },
  { scope: "project", segments: [".claude", "skills"] },
];

/** A skill file's reviewed CLI version, `null` when the file has none that can be read */
export function readReviewedVersion(skill: string) {
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

/** The file a path reaches after following links, `null` when it reaches nothing */
function resolveRealPath(path: string) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Finds the Zinn skill copies in the home folder and the working folder and compares each with the bundled skill.
 * Paths that lead to one file through links give one copy. A link that leads nowhere is no copy.
 */
export function findSkillCopies(home: string, workingFolder: string): SkillCopies {
  // The skill ships with the CLI, and release checks guarantee its version.
  const bundledVersion = readReviewedVersion(
    readFileSync(join(bundledSkillDirectory, SKILL_FILE_NAME), "utf8"),
  );
  const copies: Array<SkillCopy> = [];

  for (const { scope, segments } of SKILL_BASES) {
    const path = join(
      scope === "home" ? home : workingFolder,
      ...segments,
      "zinn",
      SKILL_FILE_NAME,
    );
    const realPath = resolveRealPath(path);
    const isAlreadyFound = copies.some((copy) => copy.realPath === realPath);

    if (realPath === null || isAlreadyFound) {
      continue;
    }

    let skill: string;

    try {
      skill = readFileSync(realPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }

      copies.push({
        path,
        realPath,
        scope,
        readable: false,
        reviewedVersion: null,
        matches: false,
      });
      continue;
    }

    const reviewedVersion = readReviewedVersion(skill);
    const matches = reviewedVersion !== null && reviewedVersion === bundledVersion;
    copies.push({ path, realPath, scope, readable: true, reviewedVersion, matches });
  }

  return { bundledVersion, copies };
}
