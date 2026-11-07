import type { TelemetryMode } from "../schemas/settings.js";
import type { SettingsFileInspection, SettingsInputs, TelemetrySource } from "../settings.js";
import type { StorageSource } from "../storage.js";

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import packageJson from "../../package.json" with { type: "json" };
import { chooseDefaultProject, inspectSettings, resolveTelemetry } from "../settings.js";
import { resolveStorage } from "../storage.js";
import { resolveDatabasePath } from "../database-path.js";
import { TELEMETRY_FOLDER_NAME } from "../constant.js";
import { errorMessage, isMissingFileError } from "../errors.js";
import { classifyDatabase, databaseStateSchema } from "../migrations/classify.js";
import { latestVersion, MIGRATIONS } from "../migrations/registry.js";

export const infoDatabaseStateSchema = z.enum([...databaseStateSchema.options, "unavailable"]);

export type StoreInfo = {
  coreVersion: string;
  settingsFiles: Array<SettingsFileInspection>;
  storage: {
    directory: string | null;
    source: StorageSource | null;
    settingsPath: string | null;
    exists: boolean | null;
    error: string | null;
  };
  defaultProject: { key: string | null; settingsPath: string | null; error: string | null };
  telemetry: {
    mode: TelemetryMode | null;
    source: TelemetrySource | null;
    settingsPath: string | null;
    maxMegabytes: number | null;
    maxAgeDays: number | null;
    directory: string | null;
    exists: boolean | null;
    sizeBytes: number | null;
    error: string | null;
  };
  database: {
    path: string | null;
    state: z.infer<typeof infoDatabaseStateSchema>;
    version: number | null;
    latestVersion: number;
    error: string | null;
  };
};

/** The total size of the files directly inside `directory`. A file removed during the read counts as `0`  */
function sumFileSizes(directory: string) {
  let total = 0;

  for (const name of readdirSync(directory)) {
    try {
      const entry = statSync(join(directory, name));
      if (entry.isFile()) {
        total += entry.size;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  return total;
}

/** Fills the telemetry folder facts. A missing folder is empty, and info never creates it. */
function inspectTelemetryDirectory(telemetry: StoreInfo["telemetry"], directory: string) {
  telemetry.directory = directory;

  try {
    if (!statSync(directory).isDirectory()) {
      telemetry.exists = false;
      telemetry.error ??= `${directory} is not a directory`;
      return;
    }

    telemetry.exists = true;
    telemetry.sizeBytes = sumFileSizes(directory);
  } catch (error) {
    if (isMissingFileError(error)) {
      telemetry.exists = false;
      telemetry.sizeBytes = 0;
    } else {
      telemetry.error ??= errorMessage(error);
    }
  }
}

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
    // A field is unknown when an unusable file could have set it: the nearest codebase file, or the global file when the codebase file leaves the field out.
    const isKnown = (isSetInLocalFile: boolean) =>
      localError === undefined && (isSetInLocalFile || globalError === undefined);
    const projectIsKnown = isKnown(settings.local?.settings.defaultProject !== undefined);
    const modeIsKnown = isKnown(settings.local?.settings.telemetry?.mode !== undefined);
    const maxMegabytesIsKnown = isKnown(
      settings.local?.settings.telemetry?.maxMegabytes !== undefined,
    );
    const maxAgeDaysIsKnown = isKnown(settings.local?.settings.telemetry?.maxAgeDays !== undefined);
    const telemetryChoice = resolveTelemetry(settings, inputs.env);
    const projectChoice = chooseDefaultProject(settings);
    const report: StoreInfo = {
      coreVersion: packageJson.version,
      settingsFiles: settings.files,
      storage: {
        directory: null,
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
      telemetry: {
        mode: modeIsKnown ? telemetryChoice.mode : null,
        source: modeIsKnown ? telemetryChoice.source : null,
        settingsPath: modeIsKnown ? telemetryChoice.settingsPath : null,
        maxMegabytes: maxMegabytesIsKnown ? telemetryChoice.maxMegabytes : null,
        maxAgeDays: maxAgeDaysIsKnown ? telemetryChoice.maxAgeDays : null,
        directory: null,
        exists: null,
        sizeBytes: null,
        error:
          modeIsKnown && maxMegabytesIsKnown && maxAgeDaysIsKnown && storageIsKnown
            ? null
            : unresolvedError,
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
        source: storage.source,
        settingsPath: storage.settingsPath,
        exists: null,
        error: null,
      };

      inspectTelemetryDirectory(
        report.telemetry,
        join(resolve(inputs.cwd, storage.directory), TELEMETRY_FOLDER_NAME),
      );

      try {
        const directory = statSync(resolve(inputs.cwd, storage.directory));
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
        const databasePath = resolveDatabasePath(resolve(inputs.cwd, storage.databasePath));
        report.database.path = databasePath;
        report.database = {
          path: databasePath,
          ...classifyDatabase(databasePath),
          error: null,
        };
      } catch (error) {
        report.database.path ??= storage.databasePath;
        report.database.error = errorMessage(error);
      }
    } catch (error) {
      report.storage.error = errorMessage(error);
      report.database.error = errorMessage(error);
      report.telemetry.error ??= errorMessage(error);
    }
    return report;
  },
};
