/**
 * Measured 2026-11-02 from the packages published in CLI 0.43.0. Download
 *  bytes are the registry tarballs, unpacked bytes are what npm writes to disk.
 *  The fixture is one project whose tasks each have a 40-character title, a
 *  200-character description and one 200-character comment. Memory is the
 *  node process's peak resident set size and, like time, the median of five
 *  runs on Node 26.13.0, macOS arm64. File sizes are read after the writing
 *  process exits.
 *
 * The per-package figures are the measurement record. The page presents Zinn's
 *  package as a whole, so it renders the totals only and names no dependency.
 */
export interface PricingPackage {
  name: string;
  version: string;
  /** Registry tarball bytes, which is what a client downloads */
  download: number;
  /** Bytes npm writes to disk */
  unpacked: number;
  files: number;
  /** True for the packages Zinn publishes */
  zinn: boolean;
}

export const pricingPackages: Array<PricingPackage> = [
  {
    name: "@zinn-dev/cli",
    version: "0.43.0",
    download: 96_178,
    unpacked: 553_641,
    files: 104,
    zinn: true,
  },
  {
    name: "@zinn-dev/core",
    version: "0.32.0",
    download: 100_592,
    unpacked: 389_498,
    files: 143,
    zinn: true,
  },
  {
    name: "zod",
    version: "4.6.4",
    download: 1_052_201,
    unpacked: 6_138_878,
    files: 840,
    zinn: false,
  },
  {
    name: "uuid",
    version: "14.0.3",
    download: 14_991,
    unpacked: 65_739,
    files: 70,
    zinn: false,
  },
  {
    name: "fractional-indexing",
    version: "4.0.0",
    download: 10_742,
    unpacked: 36_839,
    files: 5,
    zinn: false,
  },
];

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const zinnPackages = pricingPackages.filter((entry) => entry.zinn);

export const pricingTotals = {
  download: sum(pricingPackages.map((entry) => entry.download)),
  unpacked: sum(pricingPackages.map((entry) => entry.unpacked)),
  files: sum(pricingPackages.map((entry) => entry.files)),
  packageCount: pricingPackages.length,
  /** The Zinn packages alone, without what they pull in. */
  softwareDownload: sum(zinnPackages.map((entry) => entry.download)),
};

export const pricingEnvironment = {
  measured: "2026-11-02",
  cli: "0.43.0",
  node: "26.13.0",
  platform: "macOS arm64",
  tasks: 100,
  comments: 100,
  titleChars: 40,
  descriptionChars: 200,
  commentChars: 200,
  /** Peak memory of `node -e 0`, Node with no script loaded. */
  nodeMemoryBytes: 39_075_840,
};

export interface CommandCost {
  command: string;
  /** Peak resident set size of the node process. */
  memoryBytes: number;
  seconds: number;
  /** Bytes written to stdout. */
  output: number;
}

/** Against the fixture at 100 tasks with 100 comments. */
export const pricingCommands: CommandCost[] = [
  { command: "zinn task list", memoryBytes: 81_166_336, seconds: 0.12, output: 6_600 },
  { command: "zinn task list --json", memoryBytes: 80_429_056, seconds: 0.12, output: 67_095 },
  { command: "zinn task view", memoryBytes: 78_528_512, seconds: 0.11, output: 737 },
  { command: "zinn task create", memoryBytes: 80_035_840, seconds: 0.16, output: 66 },
];

/** `zinn task list` against the fixture at 10,000 tasks with 10,000 comments. */
export const largeListCost: CommandCost = {
  command: "zinn task list",
  memoryBytes: 166_428_672,
  seconds: 3.55,
  output: 680_000,
};

/** One figure for the set, since the commands differ by a few megabytes at most. */
export const typicalCommandMemoryBytes =
  pricingCommands.reduce((total, entry) => total + entry.memoryBytes, 0) / pricingCommands.length;

export const pricingDiskRows = [
  { label: "Installed", bytes: pricingTotals.unpacked },
  /** The database file once the schema and one project exist. */
  { label: "Empty database", bytes: 122_880 },
  /** Growth per task from 1,000 to 10,000 tasks without comments. */
  { label: "A task", bytes: 1_561 },
  /** Growth per comment, 10,000 tasks with their comments against 10,000 without. */
  { label: "A comment", bytes: 1_324 },
  { label: "100 tasks with 100 comments", bytes: 471_040 },
  { label: "10,000 tasks with 10,000 comments", bytes: 29_044_736 },
];

const grouped = new Intl.NumberFormat("en-US");

/** Exact byte count, grouped as a script or a receipt would print it. */
export function exactBytes(bytes: number) {
  return `${grouped.format(bytes)} B`;
}

/** Smallest size shown in whole kilobytes. Below it, one decimal place keeps 1.6 KB from rounding to 2 KB. */
const wholeKilobytesFrom = 10_000;

/** Decimal units, matching how npm reports package sizes. */
export function sizeLabel(bytes: number) {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= wholeKilobytesFrom) {
    return `${Math.round(bytes / 1000)} KB`;
  }
  if (bytes >= 1000) {
    return `${(bytes / 1000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/** Memory in whole decimal megabytes, the same units as the sizes. */
export function memoryLabel(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Decimal units with one decimal place, for output sizes between 1 KB and 1 MB. */
export function outputLabel(bytes: number) {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1000) {
    return `${(bytes / 1000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
