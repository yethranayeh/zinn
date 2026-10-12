import { homedir } from "node:os";
import { project, resolveSettings } from "@zinn-dev/core";
import { UsageError } from "./lib.js";

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
      throw new UsageError("--all-projects cannot be combined with a project key");
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
  const defaultProject = settings.merged.defaultProject;
  if (defaultProject === undefined) {
    if (required) {
      throw new UsageError(
        "Missing argument <project-key>. Supply a key or configure defaultProject",
      );
    }
    return undefined;
  }

  const settingsFile =
    settings.local?.settings.defaultProject === undefined ? settings.global! : settings.local;
  if (project.getByKey(defaultProject) == null) {
    throw new Error(
      `Default project "${defaultProject}" from settings file ${settingsFile.path} does not exist`,
    );
  }

  return defaultProject;
}
