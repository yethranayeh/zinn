import { homedir } from "node:os";
import { chooseDefaultProject, project, resolveSettings } from "@zinn-dev/core";

import { UsageError } from "./lib.js";
import { CliError } from "./errors.js";

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
    if (typedKey !== undefined) {
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
