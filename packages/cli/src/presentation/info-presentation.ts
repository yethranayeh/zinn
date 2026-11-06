import type { StoreInfo } from "@zinn-dev/core";
import type { PresentedInfo } from "../result-schemas.js";

import packageJson from "../../package.json" with { type: "json" };
import { currentRuntime } from "../run-facts.js";

export function presentInfo(report: StoreInfo): PresentedInfo {
  return {
    settingsFiles: report.settingsFiles,
    storage: report.storage,
    defaultProject: report.defaultProject,
    telemetry: report.telemetry,
    database: report.database,
    versions: {
      cli: packageJson.version,
      core: report.coreVersion,
      runtime: currentRuntime(),
    },
  };
}

function storeSource(storage: PresentedInfo["storage"]): string {
  if (storage.settingsPath !== null) {
    return storage.settingsPath;
  }
  return storage.source === "env" ? "ZINN_DIR" : "default";
}

function folderState(storage: PresentedInfo["storage"]): string {
  if (storage.error !== null) {
    return storage.error;
  }
  if (storage.exists === null) {
    return "unavailable";
  }
  return storage.exists ? "found" : "missing";
}

function telemetrySource(telemetry: PresentedInfo["telemetry"]): string {
  return telemetry.settingsPath ?? telemetry.source ?? "unavailable";
}

function telemetryFolderState(telemetry: PresentedInfo["telemetry"]): string {
  if (telemetry.exists === null) {
    return "unavailable";
  }
  if (!telemetry.exists) {
    return telemetry.sizeBytes === null ? "not a directory" : "missing";
  }
  return telemetry.sizeBytes === null ? "cannot be read" : `${telemetry.sizeBytes} bytes`;
}

function databaseState(database: PresentedInfo["database"]): string {
  if (database.error !== null) {
    return database.error;
  }
  return `${database.state}; schema ${database.version ?? "unavailable"}, latest ${database.latestVersion}`;
}

export function formatInfo(report: PresentedInfo): string {
  const { storage, database, defaultProject, telemetry, versions } = report;
  const storeIsUnavailable = storage.directory === null;

  //
  /**
   * A settings file's error text prints once, on its own line in the Settings list
   * Other fields point to the file
   */
  const unavailableReason = (error: string): string => {
    const file = report.settingsFiles.find(
      (candidate) => candidate.state === "error" && candidate.error === error,
    );

    return file === undefined ? error : `settings file ${file.path} cannot be used`;
  };

  const storeHeader = storeIsUnavailable
    ? `unavailable${storage.error === null ? "" : ` (${unavailableReason(storage.error)})`}`
    : `${storage.directory} (${storeSource(storage)})`;
  const defaultProjectText =
    defaultProject.error === null
      ? (defaultProject.key ?? "not configured")
      : `unavailable (${unavailableReason(defaultProject.error)})`;
  const defaultProjectSuffix =
    defaultProject.settingsPath === null ? "" : ` (${defaultProject.settingsPath})`;
  const telemetryReason =
    telemetry.error === null ? "" : ` (${unavailableReason(telemetry.error)})`;
  const telemetryText =
    telemetry.mode === null
      ? `unavailable${telemetryReason}`
      : `${telemetry.mode} (${telemetrySource(telemetry)})`;
  const telemetryLimit =
    telemetry.maxMegabytes === null ? "" : `, limit ${telemetry.maxMegabytes} MB`;
  const telemetryFolderText =
    telemetry.directory === null
      ? `unavailable${telemetryReason}`
      : `${telemetry.directory} (${telemetryFolderState(telemetry)})`;
  const lines = [
    `Store: ${storeHeader}`,
    `Store folder: ${storeIsUnavailable ? "unavailable" : folderState(storage)}`,
    `Database: ${database.path ?? "unavailable"}`,
    `Database state: ${storeIsUnavailable ? "unavailable" : databaseState(database)}`,
    `Default project: ${defaultProjectText}${defaultProjectSuffix}`,
    `Telemetry: ${telemetryText}${telemetryLimit}`,
    `Telemetry folder: ${telemetryFolderText}`,
    "",
    "Settings:",
  ];

  for (const file of report.settingsFiles) {
    let state: string;

    switch (file.state) {
      case "found":
        state = "found";
        break;
      case "missing":
        state = "not configured";
        break;
      case "error":
        state = file.error;
        break;
      case "not-read":
        state = `not read (${file.reason} is set)`;
        break;
    }

    lines.push(`${file.path}: ${state}`);

    if (file.state === "found") {
      if (file.settings.storage !== undefined) {
        lines.push(`  storage.directory: ${file.settings.storage.directory}`);
      }
      if (file.settings.defaultProject !== undefined) {
        lines.push(`  defaultProject: ${file.settings.defaultProject}`);
      }
      if (file.settings.telemetry?.mode !== undefined) {
        lines.push(`  telemetry.mode: ${file.settings.telemetry.mode}`);
      }
      if (file.settings.telemetry?.maxMegabytes !== undefined) {
        lines.push(`  telemetry.maxMegabytes: ${file.settings.telemetry.maxMegabytes}`);
      }
    }
  }

  lines.push(
    "",
    `CLI: ${versions.cli}`,
    `Core: ${versions.core}`,
    `Runtime: ${versions.runtime.name} ${versions.runtime.version}`,
  );
  return lines.join("\n");
}
