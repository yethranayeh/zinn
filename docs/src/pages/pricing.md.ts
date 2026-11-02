import type { APIRoute } from "astro";
import {
  exactBytes,
  largeListCost,
  memoryLabel,
  outputLabel,
  pricingCommands,
  pricingDiskRows,
  pricingEnvironment,
  pricingTotals,
  sizeLabel,
  typicalCommandMemoryBytes,
} from "../config/pricing";
import { installCommand, projectLinks } from "../config/site";

const commandRows = pricingCommands
  .map(
    ({ command, memoryBytes, seconds, output }) =>
      `| \`${command}\` | ${memoryLabel(memoryBytes)} | ${seconds.toFixed(2)} s | ${outputLabel(output)} |`,
  )
  .join("\n");
const diskRows = pricingDiskRows
  .map(({ label, bytes }) => `| ${label} | ${sizeLabel(bytes)} |`)
  .join("\n");

export const GET: APIRoute = () =>
  new Response(
    `# Pricing

Free, and that is the whole plan.

Zinn is [MIT licensed](${projectLinks.license}). There is one plan, with no account, no seats and nothing to renew. Everything below is quoted in bytes, starting with the price.

## Spot price

0 B per install, per machine, per agent.

## Shipping weight

- Net: ${sizeLabel(pricingTotals.softwareDownload)}, ${exactBytes(pricingTotals.softwareDownload)}, the software alone.
- Gross: ${sizeLabel(pricingTotals.download)}, ${exactBytes(pricingTotals.download)}, with its dependencies.

## Install

\`\`\`sh
${installCommand}
\`\`\`

## Running costs

About ${memoryLabel(typicalCommandMemoryBytes)} of memory and a tenth of a second per command. At 10,000 tasks, listing them all takes ${memoryLabel(largeListCost.memoryBytes)} and ${largeListCost.seconds.toFixed(1)} seconds.

- Idle: nothing. Zinn runs only when you call it. No background process, no memory, no writes.
- Per command: ${memoryLabel(pricingEnvironment.nodeMemoryBytes)} of that is Node itself.

| Command | Memory | Time | Output |
| --- | --- | --- | --- |
${commandRows}

Output is what the command prints, and what an agent reads.

## On disk

| Item | Size |
| --- | --- |
${diskRows}

A task has a ${pricingEnvironment.titleChars}-character title and a ${pricingEnvironment.descriptionChars}-character description. A comment is ${pricingEnvironment.commentChars} characters.

Measured ${pricingEnvironment.measured} with CLI ${pricingEnvironment.cli} and the packages it installs. Memory and time are medians of five runs on Node ${pricingEnvironment.node}, ${pricingEnvironment.platform}, against a database of ${pricingEnvironment.tasks} tasks and ${pricingEnvironment.comments} comments.
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
