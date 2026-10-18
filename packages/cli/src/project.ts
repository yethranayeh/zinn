import type { InputConstraint } from "./input.js";

import { homedir } from "node:os";
import { chooseDefaultProject, project, resolveSettings } from "@zinn-dev/core";

import { UsageError } from "./lib.js";
import { CliError } from "./errors.js";
import { violatesConstraint } from "./input.js";

export const projectScopeConstraint = {
  kind: "exclusive",
  members: ["positional:project-key", "option:all-projects"],
} as const satisfies InputConstraint;

export const requiredProjectDescription =
  "An omitted project key uses defaultProject from settings. Without a configured default, a project key is required. A missing configured project is an error.";

export const projectScopeDescription =
  "An omitted project key defaults to all projects unless defaultProject is configured. --all-projects overrides the defaultProject and excludes a typed project. A missing configured project is an error.";

/** Chooses the explicit project or the configured default, retaining unscoped list/search behavior. */
export function resolveProjectKey(
  typedKey: string | undefined,
  {
    required = false,
    allProjects = false,
    useDefault = true,
  }: {
    required?: boolean;
    allProjects?: boolean;
    useDefault?: boolean;
  } = {},
): string | undefined {
  if (allProjects) {
    if (
      violatesConstraint(projectScopeConstraint, {
        "positional:project-key": typedKey,
        "option:all-projects": allProjects,
      })
    ) {
      throw new UsageError("--all-projects cannot be combined with a project key", {
        argument: "--all-projects",
      });
    }
    return undefined;
  }

  if (typedKey !== undefined) {
    return typedKey;
  }

  if (!useDefault) {
    return undefined;
  }

  const settings = resolveSettings({ cwd: process.cwd(), env: process.env, home: homedir() });
  const defaultProject = chooseDefaultProject(settings);
  if (defaultProject === null) {
    if (required) {
      throw new UsageError(
        "Missing argument <project-key>. Supply a key or configure defaultProject",
        { argument: "project-key" },
      );
    }
    return undefined;
  }

  const { key, settingsPath } = defaultProject;
  if (project.getByKey(key) == null) {
    throw new CliError(
      `Default project "${key}" from settings file ${settingsPath} does not exist`,
      "not_found",
      { entity: "project", key, source: "defaultProject", settingsPath },
    );
  }

  return key;
}
