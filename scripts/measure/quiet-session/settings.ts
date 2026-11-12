/** Reads the prior state of each flagged setting and plans only the changes that are needed. */
import type { Runner } from "./runner.ts";
import type { ChangeKind, RestoreEntry } from "./state.ts";

import { commandLine } from "./format.ts";

const TIME_MACHINE_PREFERENCES = "/Library/Preferences/com.apple.TimeMachine";
const AUTO_BACKUP_KEY = "AutoBackup";
// `tmutil destinationinfo -X` prints a plist with an empty top-level dict when no destination is configured.
const EMPTY_PLIST_DICT = /<plist[^>]*>\s*<dict>\s*<\/dict>\s*<\/plist>/;

export type SettingFlags = {
  spotlight: boolean;
  timeMachine: boolean;
  wifi: boolean;
};

export type PlannedChange = RestoreEntry & {
  apply: Array<string>;
  applyCommand: string;
  /** The guard request words after `apply` or `undo`. */
  guard: string;
};

export type SettingPlan = {
  changes: Array<PlannedChange>;
  notes: Array<string>;
  reads: Array<string>;
};

export type PlanOptions = {
  /** Reads that only work after the password prompt may use the primed sudo ticket. */
  allowSudoReads: boolean;
};

export async function planSettingChanges(
  runner: Runner,
  flags: SettingFlags,
  options: PlanOptions,
): Promise<SettingPlan> {
  const changes: Array<PlannedChange> = [];
  const notes: Array<string> = [];
  const reads: Array<string> = [];

  if (flags.spotlight) {
    await planSpotlightChanges(runner, changes, notes, reads);
  }
  if (flags.timeMachine) {
    await planTimeMachineChange(runner, changes, notes, reads, options.allowSudoReads);
  }
  if (flags.wifi) {
    await planWifiChange(runner, changes, notes, reads);
  }

  return { changes, notes, reads };
}

async function planSpotlightChanges(
  runner: Runner,
  changes: Array<PlannedChange>,
  notes: Array<string>,
  reads: Array<string>,
) {
  const statusCommand = ["mdutil", "-s", "-a"];
  reads.push(commandLine(statusCommand));
  const result = await runner.capture(statusCommand);
  if (result.exitCode !== 0) {
    notes.push(
      `Spotlight: could not read indexing state, leaving it unchanged${failureDetail(result)}`,
    );
    return;
  }
  const volumes = parseSpotlightStatus(result.stdout);
  if (volumes.length === 0) {
    notes.push("Spotlight: no volume indexing state was reported, leaving it unchanged");
    return;
  }
  for (const volume of volumes) {
    if (volume.enabled === "read-only") {
      notes.push(`Spotlight: ${volume.volume} has a read-only index, leaving it unchanged`);
      continue;
    }
    if (volume.enabled === undefined) {
      notes.push(
        `Spotlight: could not read indexing state for ${volume.volume}, leaving it unchanged`,
      );
      continue;
    }
    if (!volume.enabled) {
      notes.push(`Spotlight: ${volume.volume} was already off, leaving it off`);
      continue;
    }
    changes.push(
      makeChange({
        id: `spotlight:${volume.volume}`,
        kind: "spotlight",
        label: `Spotlight indexing off for ${volume.volume}`,
        priorState: "on",
        apply: ["sudo", "mdutil", "-i", "off", volume.volume],
        undo: ["sudo", "mdutil", "-i", "on", volume.volume],
        guard: `spotlight ${volume.volume}`,
      }),
    );
  }
}

/** "read-only" is what mdutil reports for a volume it cannot switch, such as the sealed system volume. */
type VolumeStatus = { volume: string; enabled: boolean | "read-only" | undefined };

export function parseSpotlightStatus(output: string): Array<VolumeStatus> {
  const volumes: Array<VolumeStatus> = [];
  let currentVolume: string | undefined;
  const finishVolume = (enabled: VolumeStatus["enabled"]) => {
    if (currentVolume === undefined) {
      return;
    }
    volumes.push({ volume: currentVolume, enabled });
    currentVolume = undefined;
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.endsWith(":") && !/indexing/i.test(line)) {
      finishVolume(undefined);
      currentVolume = line.slice(0, -1);
      continue;
    }
    if (currentVolume === undefined) {
      continue;
    }
    if (/\bindexing (?:is )?(?:and searching )?disabled\b/i.test(line)) {
      finishVolume(false);
      continue;
    }
    if (/\bindexing (?:is )?enabled\b/i.test(line)) {
      finishVolume(true);
      continue;
    }
    if (/\bindex is read-only\b/i.test(line)) {
      finishVolume("read-only");
    }
  }
  finishVolume(undefined);
  return volumes;
}

async function planTimeMachineChange(
  runner: Runner,
  changes: Array<PlannedChange>,
  notes: Array<string>,
  reads: Array<string>,
  allowSudoReads: boolean,
) {
  if (!(await hasBackupDestination(runner, reads))) {
    notes.push("Time Machine isn't set up, leaving it unchanged");
    return;
  }
  const automatic = await readAutomaticBackups(runner, allowSudoReads, reads);
  if (automatic === undefined) {
    notes.push(
      "Time Machine: could not read whether automatic backups were on, leaving it unchanged",
    );
    return;
  }
  if (!automatic) {
    notes.push("Time Machine: automatic backups were already off, leaving them off");
    return;
  }
  changes.push(
    makeChange({
      id: "time-machine:automatic",
      kind: "time-machine",
      label: "Time Machine automatic backups off",
      priorState: "on",
      apply: ["sudo", "tmutil", "disable"],
      undo: ["sudo", "tmutil", "enable"],
      guard: "time-machine",
    }),
  );
}

/** Without a destination there are no automatic backups to pause, and no sudo read is needed. */
async function hasBackupDestination(runner: Runner, reads: Array<string>): Promise<boolean> {
  const readArguments = ["tmutil", "destinationinfo", "-X"];
  reads.push(commandLine(readArguments));
  const result = await runner.capture(readArguments);
  const noDestinations = result.exitCode === 0 && EMPTY_PLIST_DICT.test(result.stdout);
  return !noDestinations;
}

async function readAutomaticBackups(
  runner: Runner,
  allowSudoReads: boolean,
  reads: Array<string>,
): Promise<boolean | undefined> {
  const readArguments = ["defaults", "read", TIME_MACHINE_PREFERENCES, AUTO_BACKUP_KEY];
  reads.push(commandLine(readArguments));
  const direct = await runner.capture(readArguments);
  const directValue = parseBooleanResult(direct);
  if (directValue !== undefined) {
    return directValue;
  }
  if (!allowSudoReads) {
    return undefined;
  }
  const elevatedArguments = ["sudo", "-n", ...readArguments];
  reads.push(commandLine(elevatedArguments));
  const elevated = await runner.capture(elevatedArguments);
  return parseBooleanResult(elevated);
}

function parseBooleanResult(result: { exitCode: number; stdout: string }): boolean | undefined {
  if (result.exitCode !== 0) {
    return undefined;
  }
  const value = result.stdout.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no") {
    return false;
  }
  return undefined;
}

async function planWifiChange(
  runner: Runner,
  changes: Array<PlannedChange>,
  notes: Array<string>,
  reads: Array<string>,
) {
  const hardwareCommand = ["networksetup", "-listallhardwareports"];
  reads.push(commandLine(hardwareCommand));
  const hardware = await runner.capture(hardwareCommand);
  if (hardware.exitCode !== 0) {
    notes.push(
      `Wi-Fi: could not list hardware ports, leaving it unchanged${failureDetail(hardware)}`,
    );
    return;
  }
  const device = parseWifiDevice(hardware.stdout);
  if (device === undefined) {
    notes.push("Wi-Fi: no Wi-Fi device was found, leaving it unchanged");
    return;
  }
  const powerCommand = ["networksetup", "-getairportpower", device];
  reads.push(commandLine(powerCommand));
  const power = await runner.capture(powerCommand);
  if (power.exitCode !== 0) {
    notes.push(
      `Wi-Fi: could not read power state for ${device}, leaving it unchanged${failureDetail(power)}`,
    );
    return;
  }
  if (/:\s*off\s*$/i.test(power.stdout)) {
    notes.push(`Wi-Fi: ${device} was already off, leaving it off`);
    return;
  }
  if (!/:\s*on\s*$/i.test(power.stdout)) {
    notes.push(`Wi-Fi: power state for ${device} was not reported, leaving it unchanged`);
    return;
  }
  changes.push(
    makeChange({
      id: `wifi:${device}`,
      kind: "wifi",
      label: `Wi-Fi off for ${device}`,
      priorState: "on",
      apply: ["sudo", "networksetup", "-setairportpower", device, "off"],
      undo: ["sudo", "networksetup", "-setairportpower", device, "on"],
      guard: `wifi ${device}`,
    }),
  );
}

export function parseWifiDevice(output: string): string | undefined {
  for (const block of output.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim());
    const portLine = lines.find((line) => /^Hardware Port:/i.test(line));
    if (portLine === undefined) {
      continue;
    }
    const port = portLine
      .replace(/^Hardware Port:\s*/i, "")
      .trim()
      .toLowerCase();
    if (port !== "wi-fi" && port !== "airport") {
      continue;
    }
    const deviceLine = lines.find((line) => /^Device:/i.test(line));
    if (deviceLine !== undefined) {
      return deviceLine.replace(/^Device:\s*/i, "").trim();
    }
  }
  return undefined;
}

function makeChange(input: {
  id: string;
  kind: ChangeKind;
  label: string;
  priorState: string;
  apply: Array<string>;
  undo: Array<string>;
  guard: string;
}): PlannedChange {
  return {
    ...input,
    applyCommand: commandLine(input.apply),
    undoCommand: commandLine(input.undo),
  };
}

function failureDetail(result: { stderr: string }): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? `: ${stderr}` : "";
}
