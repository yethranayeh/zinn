import {
  databaseSizes,
  exactBytes,
  groupedNumber,
  largeListCost,
  memoryLabel,
  pricingCommands,
  pricingEnvironment,
  pricingTotals,
  sizeLabel,
} from "../../config/pricing";

/**
 * Calculator stops: one comment per task sharing the pricing config's fixture and method
 * Only `markedStops` get a mark.
 */
export const calculatorStops = [
  {
    tasks: 1,
    databaseBytes: 122_880,
    seconds: 0.12,
    memoryBytes: 79_020_032,
    outputBytes: 64,
    jsonOutputBytes: 717,
  },
  {
    tasks: 10,
    databaseBytes: 147_456,
    seconds: 0.12,
    memoryBytes: 79_708_160,
    outputBytes: 650,
    jsonOutputBytes: 7_144,
  },
  {
    tasks: 100,
    databaseBytes: 471_040,
    seconds: 0.12,
    memoryBytes: 81_920_000,
    outputBytes: 6_600,
    jsonOutputBytes: 71_495,
  },
  {
    tasks: 1_000,
    databaseBytes: 3_072_000,
    seconds: 0.18,
    memoryBytes: 94_142_464,
    outputBytes: 67_000,
    jsonOutputBytes: 715_896,
  },
  {
    tasks: 1_585,
    databaseBytes: 4_751_360,
    seconds: 0.24,
    memoryBytes: 101_040_128,
    outputBytes: 106_195,
    jsonOutputBytes: 1_135_341,
  },
  {
    tasks: 2_512,
    databaseBytes: 7_438_336,
    seconds: 0.34,
    memoryBytes: 114_180_096,
    outputBytes: 168_304,
    jsonOutputBytes: 1_800_000,
  },
  {
    tasks: 3_981,
    databaseBytes: 11_677_696,
    seconds: 0.56,
    memoryBytes: 134_381_568,
    outputBytes: 266_727,
    jsonOutputBytes: 2_853_273,
  },
  {
    tasks: 6_310,
    databaseBytes: 18_456_576,
    seconds: 1.38,
    memoryBytes: 171_098_112,
    outputBytes: 422_770,
    jsonOutputBytes: 4_523_166,
  },
  {
    tasks: 7_943,
    databaseBytes: 23_171_072,
    seconds: 2.32,
    memoryBytes: 172_687_360,
    outputBytes: 532_181,
    jsonOutputBytes: 5_694_027,
  },
  {
    tasks: 10_000,
    databaseBytes: 29_044_736,
    seconds: largeListCost.seconds,
    memoryBytes: largeListCost.memoryBytes,
    outputBytes: largeListCost.output,
    jsonOutputBytes: 7_168_897,
  },
];

export const defaultStop = 2;

/** The slider draws a mark at these stops */
export const markedStops = [1, 10, 100, 1_000, 10_000];

/** Zinn's own packages as a share of the whole download */
export const netShare = pricingTotals.softwareDownload / pricingTotals.download;

/** From the registry metadata of the published package */
export const cliIntegrity =
  "sha512-dUxF1gS3EVUTdJqNsrNiaCQvLiQlO/9dGvOjuGzy9rleK6vBBeABH0yWIsPeMz7ggKs/OW/BPkKHl2PSZMGRZA==";

/**
 * Estimated processor energy above idle, 100-task fixture, CLI 0.43.0, M4 MacBook Pro on AC.
 * Median of five 20-second blocks per command, measured 2026-11-07 with `powermetrics`
 */
export const energyPerCommand: Record<string, string> = {
  "zinn task list": "0.21 mWh",
  "zinn task list --json": "0.20 mWh",
  "zinn task view": "0.20 mWh",
  "zinn task create": "0.24 mWh",
};

/** `node -e 0`, measured the same way. */
export const nodeEnergyLabel = "0.06 mWh";

export const energyMethodNote = "Estimated processor energy above idle, on an M4 MacBook Pro.";

export const energyLabel = (command: string) => energyPerCommand[command] ?? "Measuring";

export const comparison = [
  ["Monetary charge", "None"],
  ["License", "MIT"],
  ["Accounts", "None to create"],
  ["Seats", "None to find"],
  ["Agents", "Bring your own"],
  ["Renewal", "Updates, when you want them"],
  ["Annual discount", "Nothing to discount"],
  ["Your data", "On your machine"],
];

const largestStop = calculatorStops[calculatorStops.length - 1];

export const questions: Array<{ q: string; a: string; code?: string; after?: string }> = [
  {
    q: "Can I cancel anytime?",
    a: "Yes.",
    code: "npm uninstall -g @zinn-dev/cli",
    after: "Uninstalling leaves your data in place, in the Zinn directory.",
  },
  {
    q: "Is there a free trial?",
    a: "You are free to try, and encouraged to keep using it.",
  },
  {
    q: "Do you offer annual billing?",
    a: "Billing happens when you update, and you choose when.",
    code: "npm i -g @zinn-dev/cli@latest",
  },
  {
    q: "What are the overage charges?",
    a: `Commands cost more as a project grows. Listing ${groupedNumber(largestStop.tasks)} tasks takes ${largestStop.seconds.toFixed(2)} seconds and ${memoryLabel(largestStop.memoryBytes)}. The calculator above has the other sizes.`,
  },
  {
    q: "Do you offer refunds?",
    a: "You can uninstall and your lost disk bytes come back. Memory already comes back every time a command exits. The electricity does not come back.",
  },
  {
    q: "Does it cost anything when I am not using it?",
    a: "No. Zinn runs only when you call it. No background process, no memory, no writes.",
  },
];

export const measurementNote = `Measured with CLI ${pricingEnvironment.cli} and the packages it installs. Memory and time are medians of five runs on Node ${pricingEnvironment.node}, ${pricingEnvironment.platform}. Each task has a ${pricingEnvironment.titleChars}-character title, a ${pricingEnvironment.descriptionChars}-character description and one ${pricingEnvironment.commentChars}-character comment.`;

export const storageNote = `An empty database is ${sizeLabel(databaseSizes.empty)}. In large projects, a task adds about ${sizeLabel(databaseSizes.task)} and a comment about ${sizeLabel(databaseSizes.comment)}.`;

const firstCommand = pricingCommands[0];

/** fill is how much of the step's bar is drawn, from 0 to 1 */
export const storySteps = [
  {
    name: "Download",
    figure: sizeLabel(pricingTotals.download),
    text: `Over your connection, once per update. ${exactBytes(pricingTotals.download)} of compressed packages.`,
    fill: 1 / 3,
  },
  {
    name: "Unpack",
    figure: sizeLabel(pricingTotals.unpacked),
    text: `On your disk, in ${groupedNumber(pricingTotals.files)} files.`,
    fill: 2 / 3,
  },
  {
    name: "First command",
    figure: `${memoryLabel(firstCommand.memoryBytes)}, ${firstCommand.seconds.toFixed(2)} s`,
    text: "Memory and time for one task list. Memory comes back when it exits.",
    fill: 1,
  },
  {
    name: "Idle",
    figure: "Nothing",
    text: "The command has exited. No background process, no memory, and no writes until you call it again.",
    fill: 0,
  },
];
