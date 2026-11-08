import type { APIRoute } from "astro";
import {
  calculatorStops,
  cliIntegrity,
  comparison,
  energyLabel,
  energyMethodNote,
  measurementNote,
  netShare,
  nodeEnergyLabel,
  questions,
  storageNote,
  storySteps,
  telemetryNote,
} from "../components/pricing/figures";
import {
  exactBytes,
  groupedNumber,
  memoryLabel,
  outputLabel,
  pricingCommands,
  pricingEnvironment,
  pricingTotals,
  sizeLabel,
} from "../config/pricing";
import { installCommand, projectLinks } from "../config/site";

const storyRows = storySteps
  .map(({ name, figure, text }, index) => `${index + 1}. ${name}: ${figure}. ${text}`)
  .join("\n");
const stopRows = calculatorStops
  .map(
    ({ tasks, databaseBytes, seconds, memoryBytes, outputBytes, jsonOutputBytes }) =>
      `| ${groupedNumber(tasks)} | ${sizeLabel(databaseBytes)} | ${seconds.toFixed(2)} s | ${memoryLabel(memoryBytes)} | ${outputLabel(outputBytes)} | ${outputLabel(jsonOutputBytes)} |`,
  )
  .join("\n");
const commandRows = pricingCommands
  .map(
    ({ command, memoryBytes, seconds, output }) =>
      `| \`${command}\` | ${outputLabel(output)} | ${memoryLabel(memoryBytes)} | ${seconds.toFixed(2)} s | ${energyLabel(command)} |`,
  )
  .join("\n");
const comparisonRows = comparison.map(([feature, value]) => `| ${feature} | ${value} |`).join("\n");
const questionRows = questions
  .map(({ q, a, code, after }) =>
    [`### ${q}`, a, code && `\`\`\`sh\n${code}\n\`\`\``, after].filter(Boolean).join("\n\n"),
  )
  .join("\n\n");

export const GET: APIRoute = () =>
  new Response(
    `# Pricing

One plan. Priced in bytes.

Zinn is an Experimental kanban CLI for you and your agents.

Zinn is [MIT licensed](${projectLinks.license}), so there is no monetary charge. You don't have to create an account, or find a seat for you and your team to sit on. You still pay, the way you pay for all free software: in download, disk, memory, time, output, electricity and your internet bill. This page is the bill.

\`\`\`sh
${installCommand}
\`\`\`

[GitHub](${projectLinks.github}) · [npm](${projectLinks.npm}) · [Installation docs](https://zinn.sh/docs/installation)

## Billed by download

- Gross: ${sizeLabel(pricingTotals.download)}, ${exactBytes(pricingTotals.download)}, compressed packages, with dependencies.
- Net: ${sizeLabel(pricingTotals.softwareDownload)}, ${exactBytes(pricingTotals.softwareDownload)}, compressed Zinn packages, ${(netShare * 100).toFixed(1)}% of the download.

## What you pay, in order

${storyRows}

## Usage calculator

What a project of your size costs, at the sizes we measured. Each task has one comment. The list figures are for \`zinn task list\`.

| Tasks | Database | List time | List memory | List output | As JSON |
| --- | --- | --- | --- | --- | --- |
${stopRows}

${storageNote} ${telemetryNote.text} [${telemetryNote.linkLabel}](https://zinn.sh${telemetryNote.href}) ${telemetryNote.after}

## Running costs

What an agent has to read, against a database of ${pricingEnvironment.tasks} tasks and ${pricingEnvironment.comments} comments. Output is what the command prints.

| Command | Output | Memory | Time | Electricity |
| --- | --- | --- | --- | --- |
${commandRows}

${memoryLabel(pricingEnvironment.nodeMemoryBytes)} of that memory and ${nodeEnergyLabel} of that electricity is Node itself. ${energyMethodNote}

## Compare plans

All one of them.

| Feature | Zinn |
| --- | --- |
${comparisonRows}

## Frequently asked questions

${questionRows}

## Enterprise

Same plan. Same bytes. [Contact sales](https://zinn.sh/contact).

${measurementNote}

CLI ${pricingEnvironment.cli} checksum \`${cliIntegrity}\`, from \`npm view @zinn-dev/cli@${pricingEnvironment.cli} dist.integrity\`.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
