import type { StoreInfo } from "@zinn-dev/core";
import packageJson from "../../package.json" with { type: "json" };

export function presentInfo({ coreVersion, ...report }: StoreInfo) {
  const bunVersion = process.versions.bun;

  return {
    ...report,
    versions: {
      cli: packageJson.version,
      core: coreVersion,
      runtime: {
        name: bunVersion === undefined ? "Node" : "Bun",
        version: bunVersion ?? process.versions.node,
      },
    },
  };
}

export type PresentedInfo = ReturnType<typeof presentInfo>;

export function formatInfo(report: PresentedInfo): string {
  const { storage, database, defaultProject, versions } = report;
  const source =
    storage.settingsPath ??
    (storage.source === "env"
      ? "ZINN_DIR"
      : storage.source === "default"
        ? "default"
        : "unavailable");
  const lines = [
    `Store: ${storage.directory ?? "unavailable"} (${source})`,
    `Store folder: ${storage.error ?? (storage.exists === null ? "unavailable" : storage.exists ? "found" : "missing")}`,
    `Database: ${database.path ?? "unavailable"}`,
    `Database state: ${database.error ?? `${database.state}; schema ${database.version ?? "unavailable"}, latest ${database.latestVersion}`}`,
    `Default project: ${defaultProject.error === null ? (defaultProject.key ?? "not configured") : `unavailable (${defaultProject.error})`}${defaultProject.settingsPath === null ? "" : ` (${defaultProject.settingsPath})`}`,
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
