import type { NodeKind } from "./flow-palette";

import {
  databaseSizes,
  groupedNumber,
  memoryLabel,
  outputLabel,
  pricingCommands,
  pricingEnvironment,
  pricingTotals,
  sizeLabel,
} from "../../config/pricing";
import { calculatorStops, energyPerCommand, nodeEnergyLabel } from "../pricing/figures";
import { kindColors } from "./flow-palette";

/**
 * Flow figures for the performance page.
 * ! FIXME: The 100-task command and package values are measured. Node timings, p95, install timings, the extra commands and 100,000 tasks are placeholders.
 */
export const fixture = pricingEnvironment;

// FIXME
export const mockNote =
  "Mock figures. The 100-task command and package values are measured. Node timings, p95, install timings, the extra commands and 100,000 tasks are placeholders.";

/** Memory in whole megabytes, or gigabytes above 1_000 MB */
export function memory(bytes: number) {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : memoryLabel(bytes);
}

export const secondsLabel = (seconds: number) => `${seconds.toFixed(2)} s`;
export const output = outputLabel;
export const size = sizeLabel;
export const count = groupedNumber;

function measuredCommand(name: string) {
  const entry = pricingCommands.find((candidate) => candidate.command === name);
  if (!entry) {
    throw new Error(`Missing measured command: ${name}`);
  }

  return entry;
}

const listCommand = measuredCommand("zinn task list");
const listJsonCommand = measuredCommand("zinn task list --json");
const viewCommand = measuredCommand("zinn task view");
const createCommand = measuredCommand("zinn task create");

const p95ByCommand: Record<string, number> = {
  "zinn task list": 0.14,
  "zinn task list --json": 0.15,
  "zinn task view": 0.13,
  "zinn task create": 0.19,
};

function p95For(name: string) {
  const value = p95ByCommand[name];
  if (value === undefined) {
    throw new Error(`Missing p95 placeholder: ${name}`);
  }

  return value;
}

export interface CommandBenchmark {
  command: string;
  p50: number;
  p95: number;
  memoryBytes: number;
  outputBytes: number;
  mock?: boolean;
}

export const commands: Array<CommandBenchmark> = [
  {
    command: listCommand.command,
    p50: listCommand.seconds,
    p95: p95For(listCommand.command),
    memoryBytes: listCommand.memoryBytes,
    outputBytes: listCommand.output,
  },
  {
    command: listJsonCommand.command,
    p50: listJsonCommand.seconds,
    p95: p95For(listJsonCommand.command),
    memoryBytes: listJsonCommand.memoryBytes,
    outputBytes: listJsonCommand.output,
  },
  {
    command: viewCommand.command,
    p50: viewCommand.seconds,
    p95: p95For(viewCommand.command),
    memoryBytes: viewCommand.memoryBytes,
    outputBytes: viewCommand.output,
  },
  {
    command: createCommand.command,
    p50: createCommand.seconds,
    p95: p95For(createCommand.command),
    memoryBytes: createCommand.memoryBytes,
    outputBytes: createCommand.output,
  },
  {
    command: "zinn task move",
    p50: 0.17,
    p95: 0.21,
    memoryBytes: 80_900_000,
    outputBytes: 66,
    mock: true,
  },
  {
    command: "zinn task search amarillo BNCH",
    p50: 0.23,
    p95: 0.31,
    memoryBytes: 84_200_000,
    outputBytes: 4_120,
    mock: true,
  },
  {
    command: "zinn backup",
    p50: 0.31,
    p95: 0.38,
    memoryBytes: 83_400_000,
    outputBytes: 120,
    mock: true,
  },
];

function calculatorStop(tasks: number) {
  const entry = calculatorStops.find((candidate) => candidate.tasks === tasks);
  if (!entry) {
    throw new Error(`Missing calculator stop: ${tasks}`);
  }
  return entry;
}

const stop100 = calculatorStop(100);
const stop1k = calculatorStop(1_000);
const stop10k = calculatorStop(10_000);

export interface ProjectSize {
  tasks: number;
  databaseBytes: number;
  seconds: number;
  memoryBytes: number;
  jsonBytes: number;
  mock?: boolean;
}

export const projectSizes: Array<ProjectSize> = [
  {
    tasks: 100,
    databaseBytes: stop100.databaseBytes,
    seconds: stop100.seconds,
    memoryBytes: stop100.memoryBytes,
    jsonBytes: stop100.jsonOutputBytes,
  },
  {
    tasks: 1_000,
    databaseBytes: stop1k.databaseBytes,
    seconds: stop1k.seconds,
    memoryBytes: stop1k.memoryBytes,
    jsonBytes: stop1k.jsonOutputBytes,
  },
  {
    tasks: 10_000,
    databaseBytes: stop10k.databaseBytes,
    seconds: stop10k.seconds,
    memoryBytes: stop10k.memoryBytes,
    jsonBytes: stop10k.jsonOutputBytes,
  },
  {
    tasks: 100_000,
    databaseBytes: 286_000_000,
    seconds: 34.8,
    memoryBytes: 1_060_000_000,
    jsonBytes: 67_300_000,
    mock: true,
  },
];

export const storage = {
  empty: databaseSizes.empty,
  task: databaseSizes.task,
  comment: databaseSizes.comment,
  tenK: stop10k.databaseBytes,
  hundredK: 286_000_000,
};

export const packages = {
  download: pricingTotals.download,
  zinn: pricingTotals.softwareDownload,
  unpacked: pricingTotals.unpacked,
  files: pricingTotals.files,
};

export const runtime = {
  baseline: pricingEnvironment.nodeMemoryBytes,
  startupMs: 41,
  energy: energyPerCommand["zinn task list --json"] ?? "Measuring",
  nodeEnergy: nodeEnergyLabel,
};

export interface FlowRow {
  label: string;
  value: string;
}

export interface FlowPort {
  name: string;
  row: number;
}

export interface FlowNode {
  id: string;
  title: string;
  kind: NodeKind;
  x: number;
  y: number;
  rows: Array<FlowRow>;
  inputs?: Array<FlowPort>;
  outputs?: Array<FlowPort>;
  note: string;
  metric: { label: string; value: string };
  number?: number;
}

export interface FlowLink {
  from: string;
  fromPort: number;
  to: string;
  toPort: number;
  label?: string;
  dashed?: boolean;
}

export interface TimeSegment {
  label: string;
  ms: number;
  color: string;
}

export type FlowId = "read" | "write" | "install";

export interface Flow {
  id: FlowId;
  name: string;
  command: string;
  summary: string;
  nodes: Array<FlowNode>;
  links: Array<FlowLink>;
  keyFigures: Array<{ label: string; value: string }>;
  timeSplit: Array<TimeSegment>;
  totalMs: number;
}

const moduleLoad = "var(--perf-kind-module)";

const readFlow: Flow = {
  id: "read",
  name: "Read",
  command: listJsonCommand.command,
  summary: "One command from an agent to SQLite and back. The JSON is what the agent reads.",
  keyFigures: [
    { label: "p50", value: secondsLabel(listJsonCommand.seconds) },
    { label: "Peak memory", value: memory(listJsonCommand.memoryBytes) },
    { label: "Output", value: output(listJsonCommand.output) },
    { label: "Database", value: size(stop100.databaseBytes) },
  ],
  totalMs: 120,
  timeSplit: [
    { label: "Node boot", ms: 41, color: kindColors.runtime },
    { label: "Module load", ms: 38, color: moduleLoad },
    { label: "CLI", ms: 12, color: kindColors.cli },
    { label: "Core", ms: 2, color: kindColors.core },
    { label: "SQLite", ms: 3, color: kindColors.sqlite },
    { label: "Disk", ms: 1, color: kindColors.disk },
    { label: "Output", ms: 1, color: kindColors.output },
    { label: "Exit", ms: 22, color: kindColors.bin },
  ],
  nodes: [
    {
      id: "agent",
      title: "Agent",
      kind: "agent",
      x: -280,
      y: -80,
      number: 1,
      metric: { label: "waits", value: "0.12 s" },
      rows: [
        { label: "command", value: "task list --json" },
        { label: "waits", value: "0.12 s" },
        { label: "context", value: "71.5 KB" },
      ],
      outputs: [{ name: "argv", row: 0 }],
      note: "The agent sends one command and waits. The wait is the whole round trip.",
    },
    {
      id: "runtime",
      title: "Node runtime",
      kind: "runtime",
      x: -280,
      y: 140,
      number: 2,
      metric: { label: "baseline", value: "38 MB" },
      rows: [
        { label: "baseline", value: "38 MB" },
        { label: "startup", value: "41 ms" },
        { label: "modules", value: "38 ms" },
      ],
      outputs: [{ name: "heap", row: 0 }],
      note: "Node starts, loads modules and holds 38 MB before Zinn reads a task.",
    },
    {
      id: "cli",
      title: "CLI",
      kind: "cli",
      x: 20,
      y: 20,
      number: 3,
      metric: { label: "parse", value: "12 ms" },
      rows: [
        { label: "argv", value: "parsed" },
        { label: "heap", value: "82 MB" },
        { label: "parse", value: "12 ms" },
        { label: "operation", value: "task.list" },
      ],
      inputs: [
        { name: "argv", row: 0 },
        { name: "heap", row: 1 },
      ],
      outputs: [{ name: "operation", row: 3 }],
      note: "The CLI parses the command and chooses the operation.",
    },
    {
      id: "core",
      title: "Core",
      kind: "core",
      x: 340,
      y: 20,
      number: 4,
      metric: { label: "schema", value: "0.8 ms" },
      rows: [
        { label: "operation", value: "task.list" },
        { label: "schema", value: "0.8 ms" },
        { label: "query", value: "SELECT" },
        { label: "rows", value: "71.5 KB" },
      ],
      inputs: [
        { name: "operation", row: 0 },
        { name: "rows", row: 3 },
      ],
      outputs: [
        { name: "query", row: 2 },
        { name: "rows", row: 3 },
      ],
      note: "Core validates the request and shapes the rows.",
    },
    {
      id: "sqlite",
      title: "SQLite",
      kind: "sqlite",
      x: 340,
      y: 300,
      number: 5,
      metric: { label: "query", value: "2.4 ms" },
      rows: [
        { label: "query", value: "SELECT" },
        { label: "pages", value: "41" },
        { label: "rows", value: "71.5 KB" },
      ],
      inputs: [{ name: "query", row: 0 }],
      outputs: [
        { name: "pages", row: 1 },
        { name: "rows", row: 2 },
      ],
      note: "SQLite runs the query and reads pages from the database file.",
    },
    {
      id: "disk",
      title: "Disk",
      kind: "disk",
      x: 340,
      y: 540,
      number: 6,
      metric: { label: "read", value: "512 KB" },
      rows: [
        { label: "pages", value: "512 KB" },
        { label: "file", value: "471 KB" },
        { label: "open", value: "0.3 ms" },
      ],
      inputs: [{ name: "pages", row: 0 }],
      note: "The database file is 471 KB at 100 tasks. The read touches 512 KB.",
    },
    {
      id: "output",
      title: "stdout",
      kind: "output",
      x: 660,
      y: 20,
      number: 7,
      metric: { label: "JSON", value: "71.5 KB" },
      rows: [
        { label: "rows", value: "71.5 KB" },
        { label: "write", value: "0.4 ms" },
        { label: "JSON", value: "71.5 KB" },
      ],
      inputs: [{ name: "rows", row: 0 }],
      outputs: [{ name: "JSON", row: 2 }],
      note: "The JSON is 71.5 KB for 100 tasks. The agent reads it as context.",
    },
    {
      id: "context",
      title: "Agent context",
      kind: "context",
      x: 960,
      y: 20,
      number: 8,
      metric: { label: "tokens", value: "17.9k" },
      rows: [
        { label: "JSON", value: "71.5 KB" },
        { label: "tokens", value: "17.9k" },
        { label: "budget", value: "200k" },
      ],
      inputs: [{ name: "JSON", row: 0 }],
      note: "About 17,900 tokens of context for 100 tasks, against a 200,000-token budget.",
    },
  ],
  links: [
    { from: "agent", fromPort: 0, to: "cli", toPort: 0, label: "argv" },
    { from: "runtime", fromPort: 0, to: "cli", toPort: 1, label: "38 MB" },
    { from: "cli", fromPort: 0, to: "core", toPort: 0, label: "task.list" },
    { from: "core", fromPort: 0, to: "sqlite", toPort: 0, label: "SELECT" },
    { from: "sqlite", fromPort: 1, to: "core", toPort: 1, label: "100 rows", dashed: true },
    { from: "core", fromPort: 1, to: "output", toPort: 0, label: "71.5 KB" },
    { from: "sqlite", fromPort: 0, to: "disk", toPort: 0, label: "512 KB" },
    { from: "output", fromPort: 0, to: "context", toPort: 0, label: "JSON" },
  ],
};

const writeFlow: Flow = {
  id: "write",
  name: "Write",
  command: createCommand.command,
  summary: "One create. The row is small, but the write still has to reach the disk.",
  keyFigures: [
    { label: "p50", value: secondsLabel(createCommand.seconds) },
    { label: "Peak memory", value: memory(createCommand.memoryBytes) },
    { label: "Output", value: output(createCommand.output) },
    { label: "Database", value: size(stop100.databaseBytes) },
  ],
  totalMs: 160,
  timeSplit: [
    { label: "Node boot", ms: 41, color: kindColors.runtime },
    { label: "Module load", ms: 37, color: moduleLoad },
    { label: "CLI", ms: 14, color: kindColors.cli },
    { label: "Core", ms: 2, color: kindColors.core },
    { label: "SQLite", ms: 4, color: kindColors.sqlite },
    { label: "Disk", ms: 12, color: kindColors.disk },
    { label: "WAL", ms: 8, color: kindColors.wal },
    { label: "Output", ms: 1, color: kindColors.output },
    { label: "Exit", ms: 41, color: kindColors.bin },
  ],
  nodes: [
    {
      id: "agent",
      title: "Agent",
      kind: "agent",
      x: -280,
      y: -80,
      number: 1,
      metric: { label: "waits", value: "0.16 s" },
      rows: [
        { label: "command", value: "task create" },
        { label: "waits", value: "0.16 s" },
        { label: "context", value: "66 B" },
      ],
      outputs: [{ name: "argv", row: 0 }],
      note: "The agent sends one create and waits for the result.",
    },
    {
      id: "runtime",
      title: "Node runtime",
      kind: "runtime",
      x: -280,
      y: 140,
      number: 2,
      metric: { label: "baseline", value: "38 MB" },
      rows: [
        { label: "baseline", value: "38 MB" },
        { label: "startup", value: "41 ms" },
        { label: "modules", value: "37 ms" },
      ],
      outputs: [{ name: "heap", row: 0 }],
      note: "Node starts, loads modules and holds 38 MB before Zinn writes a row.",
    },
    {
      id: "cli",
      title: "CLI",
      kind: "cli",
      x: 20,
      y: 20,
      number: 3,
      metric: { label: "parse", value: "14 ms" },
      rows: [
        { label: "argv", value: "parsed" },
        { label: "heap", value: "81 MB" },
        { label: "parse", value: "14 ms" },
        { label: "operation", value: "task.create" },
      ],
      inputs: [
        { name: "argv", row: 0 },
        { name: "heap", row: 1 },
      ],
      outputs: [{ name: "operation", row: 3 }],
      note: "The CLI parses the flags and chooses the create operation.",
    },
    {
      id: "core",
      title: "Core",
      kind: "core",
      x: 340,
      y: 20,
      number: 4,
      metric: { label: "validate", value: "1.2 ms" },
      rows: [
        { label: "operation", value: "task.create" },
        { label: "validate", value: "1.2 ms" },
        { label: "write", value: "INSERT" },
        { label: "rows", value: "66 B" },
      ],
      inputs: [{ name: "operation", row: 0 }],
      outputs: [
        { name: "write", row: 2 },
        { name: "rows", row: 3 },
      ],
      note: "Core checks the fields and builds the insert.",
    },
    {
      id: "sqlite",
      title: "SQLite",
      kind: "sqlite",
      x: 340,
      y: 300,
      number: 5,
      metric: { label: "insert", value: "1.8 ms" },
      rows: [
        { label: "write", value: "INSERT" },
        { label: "frames", value: "2" },
        { label: "rows", value: "1" },
      ],
      inputs: [{ name: "write", row: 0 }],
      outputs: [{ name: "frames", row: 1 }],
      note: "SQLite writes the row and appends frames to the WAL.",
    },
    {
      id: "disk",
      title: "Disk",
      kind: "disk",
      x: 340,
      y: 540,
      number: 6,
      metric: { label: "write", value: "4 KB" },
      rows: [
        { label: "frames", value: "4 KB" },
        { label: "file", value: "471 KB" },
        { label: "sync", value: "0.6 ms" },
        { label: "WAL", value: "8 KB" },
      ],
      inputs: [{ name: "frames", row: 0 }],
      outputs: [{ name: "WAL", row: 3 }],
      note: "The row is small. The file system still has to make it durable.",
    },
    {
      id: "wal",
      title: "WAL",
      kind: "wal",
      x: 660,
      y: 540,
      number: 7,
      metric: { label: "frames", value: "2" },
      rows: [
        { label: "frames", value: "2" },
        { label: "size", value: "8 KB" },
        { label: "checkpoint", value: "later" },
      ],
      inputs: [{ name: "frames", row: 0 }],
      note: "Two frames, 8 KB. A checkpoint folds them into the database later.",
    },
    {
      id: "output",
      title: "stdout",
      kind: "output",
      x: 660,
      y: 20,
      number: 8,
      metric: { label: "JSON", value: "66 B" },
      rows: [
        { label: "rows", value: "66 B" },
        { label: "write", value: "0.2 ms" },
        { label: "JSON", value: "66 B" },
      ],
      inputs: [{ name: "rows", row: 0 }],
      outputs: [{ name: "JSON", row: 2 }],
      note: "The confirmation is 66 bytes. The agent does not need the whole task.",
    },
    {
      id: "context",
      title: "Agent context",
      kind: "context",
      x: 960,
      y: 20,
      number: 9,
      metric: { label: "tokens", value: "17" },
      rows: [
        { label: "JSON", value: "66 B" },
        { label: "tokens", value: "17" },
        { label: "budget", value: "200k" },
      ],
      inputs: [{ name: "JSON", row: 0 }],
      note: "The create reply costs about 17 tokens of context.",
    },
  ],
  links: [
    { from: "agent", fromPort: 0, to: "cli", toPort: 0, label: "argv" },
    { from: "runtime", fromPort: 0, to: "cli", toPort: 1, label: "38 MB" },
    { from: "cli", fromPort: 0, to: "core", toPort: 0, label: "task.create" },
    { from: "core", fromPort: 0, to: "sqlite", toPort: 0, label: "INSERT" },
    { from: "sqlite", fromPort: 0, to: "disk", toPort: 0, label: "4 KB" },
    { from: "disk", fromPort: 0, to: "wal", toPort: 0, label: "WAL" },
    { from: "core", fromPort: 1, to: "output", toPort: 0, label: "66 B" },
    { from: "output", fromPort: 0, to: "context", toPort: 0, label: "JSON" },
  ],
};

const installFlow: Flow = {
  id: "install",
  name: "Install",
  command: "npm i -g @zinn-dev/cli",
  summary: "One update. The tarball is small. The unpacked tree is not.",
  keyFigures: [
    { label: "Download", value: size(packages.download) },
    { label: "Unpacked", value: size(packages.unpacked) },
    { label: "Files", value: count(packages.files) },
    { label: "Zinn", value: size(packages.zinn) },
  ],
  totalMs: 730,
  timeSplit: [
    { label: "Registry", ms: 380, color: kindColors.registry },
    { label: "npm", ms: 210, color: kindColors.npm },
    { label: "Unpack", ms: 120, color: kindColors.core },
    { label: "Link", ms: 20, color: kindColors.bin },
  ],
  nodes: [
    {
      id: "registry",
      title: "Registry",
      kind: "registry",
      x: -280,
      y: 40,
      number: 1,
      metric: { label: "tarball", value: "1.3 MB" },
      rows: [
        { label: "tarball", value: "1.3 MB" },
        { label: "version", value: pricingEnvironment.cli },
        { label: "integrity", value: "sha512" },
      ],
      outputs: [{ name: "tarball", row: 0 }],
      note: "The tarball is 1.3 MB compressed.",
    },
    {
      id: "npm",
      title: "npm",
      kind: "npm",
      x: 20,
      y: 40,
      number: 2,
      metric: { label: "unpack", value: "7.2 MB" },
      rows: [
        { label: "tarball", value: "1.3 MB" },
        { label: "cache", value: "kept" },
        { label: "unpack", value: "7.2 MB" },
        { label: "tree", value: "1,162 files" },
      ],
      inputs: [{ name: "tarball", row: 0 }],
      outputs: [
        { name: "cache", row: 1 },
        { name: "tree", row: 3 },
      ],
      note: "npm unpacks 7.2 MB into 1,162 files.",
    },
    {
      id: "disk",
      title: "Disk",
      kind: "disk",
      x: 340,
      y: 40,
      number: 3,
      metric: { label: "tree", value: "7.2 MB" },
      rows: [
        { label: "tree", value: "7.2 MB" },
        { label: "files", value: "1,162" },
        { label: "writes", value: "1,162" },
      ],
      inputs: [{ name: "tree", row: 0 }],
      outputs: [{ name: "files", row: 1 }],
      note: "The package tree lands on disk, once per update.",
    },
    {
      id: "bin",
      title: "Bin",
      kind: "bin",
      x: 660,
      y: 40,
      number: 4,
      metric: { label: "link", value: "1" },
      rows: [
        { label: "link", value: "1" },
        { label: "shim", value: "zinn" },
        { label: "version", value: pricingEnvironment.cli },
      ],
      inputs: [{ name: "files", row: 0 }],
      note: "One link and a shim put zinn on the PATH.",
    },
    {
      id: "cache",
      title: "npm cache",
      kind: "cache",
      x: 340,
      y: 280,
      number: 5,
      metric: { label: "tarball", value: "1.3 MB" },
      rows: [
        { label: "tarball", value: "1.3 MB" },
        { label: "hit", value: "next time" },
      ],
      inputs: [{ name: "cache", row: 0 }],
      note: "The tarball stays in the npm cache for the next install.",
    },
  ],
  links: [
    { from: "registry", fromPort: 0, to: "npm", toPort: 0, label: "tarball" },
    { from: "npm", fromPort: 0, to: "cache", toPort: 0, label: "cache", dashed: true },
    { from: "npm", fromPort: 1, to: "disk", toPort: 0, label: "7.2 MB" },
    { from: "disk", fromPort: 0, to: "bin", toPort: 0, label: "1,162" },
  ],
};

export const flows: Array<Flow> = [readFlow, writeFlow, installFlow];

export const flowById: Record<FlowId, Flow> = {
  read: readFlow,
  write: writeFlow,
  install: installFlow,
};

/** The read flow is the page's main figure */
export const readNodes = readFlow.nodes;
