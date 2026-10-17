import type { SettingsFileInspection, SettingsInputs } from "../settings.js";
import type { StorageSource } from "../constant.js";
import type { DatabaseClassification } from "../migrations/classify.js";

import { statSync } from "node:fs";
import { homedir } from "node:os";

import packageJson from "../../package.json" with { type: "json" };
import { chooseDefaultProject, inspectSettings } from "../settings.js";
import { resolveStorage } from "../constant.js";
import { errorMessage, isMissingFileError } from "../errors.js";
import { classifyDatabase } from "../migrations/classify.js";
import { latestVersion, MIGRATIONS } from "../migrations/registry.js";

export type StoreInfo = {
  coreVersion: string;
  settingsFiles: Array<SettingsFileInspection>;
  storage: {
    directory: string | null;
    databasePath: string | null;
    source: StorageSource | null;
    settingsPath: string | null;
    exists: boolean | null;
    error: string | null;
  };
  defaultProject: { key: string | null; settingsPath: string | null; error: string | null };
  database: {
    path: string | null;
    state: DatabaseClassification["state"] | "unavailable";
    version: number | null;
    latestVersion: number;
    error: string | null;
  };
};

export const info = {
  /** Reports the selected settings and database without initializing or upgrading them. */
  get(
    inputs: SettingsInputs = { cwd: process.cwd(), env: process.env, home: homedir() },
  ): StoreInfo {
    const settings = inspectSettings(inputs);
    const selectedFiles = settings.files.filter((file) => file.state !== "not-read");
    const localError = selectedFiles.find(
      (file) => file.source === "local" && file.state === "error",
    );
    const globalError = selectedFiles.find(
      (file) => file.source !== "local" && file.state === "error",
    );
    const settingsError = localError ?? globalError;
    const unresolvedError = settingsError?.state === "error" ? settingsError.error : null;
    const storageIsKnown =
      inputs.env.ZINN_DIR !== undefined ||
      (localError === undefined &&
        (settings.local?.settings.storage !== undefined || globalError === undefined));
    const projectIsKnown =
      localError === undefined &&
      (settings.local?.settings.defaultProject !== undefined || globalError === undefined);
    const projectChoice = chooseDefaultProject(settings);
    const report: StoreInfo = {
      coreVersion: packageJson.version,
      settingsFiles: settings.files,
      storage: {
        directory: null,
        databasePath: null,
        source: null,
        settingsPath: null,
        exists: null,
        error: unresolvedError,
      },
      defaultProject: {
        key: projectIsKnown ? (projectChoice?.key ?? null) : null,
        settingsPath: projectIsKnown ? (projectChoice?.settingsPath ?? null) : null,
        error: projectIsKnown ? null : unresolvedError,
      },
      database: {
        path: null,
        state: "unavailable",
        version: null,
        latestVersion: latestVersion(MIGRATIONS),
        error: unresolvedError,
      },
    };

    if (!storageIsKnown) {
      return report;
    }

    try {
      const storage = resolveStorage(inputs, settings);
      report.storage = {
        directory: storage.directory,
        databasePath: storage.databasePath,
        source: storage.source,
        settingsPath: storage.settingsPath,
        exists: null,
        error: null,
      };
      report.database.path = storage.databasePath;

      try {
        const directory = statSync(storage.directory);
        report.storage.exists = directory.isDirectory();
        if (!directory.isDirectory()) {
          report.storage.error = `${storage.directory} is not a directory`;
        }
      } catch (error) {
        if (isMissingFileError(error)) {
          report.storage.exists = false;
        } else {
          report.storage.error = errorMessage(error);
        }
      }

      try {
        report.database = {
          path: storage.databasePath,
          ...classifyDatabase(storage.databasePath),
          error: null,
        };
      } catch (error) {
        report.database.error = errorMessage(error);
      }
    } catch (error) {
      report.storage.error = errorMessage(error);
      report.database.error = errorMessage(error);
    }
    return report;
  },
};
