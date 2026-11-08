import type { APIRoute } from "astro";
import {
  commands,
  count,
  fixture,
  memory,
  mockNote,
  output,
  packages,
  projectSizes,
  secondsLabel,
  size,
  storage,
  flows,
} from "../components/performance/flow-data";
import { formatMs } from "../components/performance/flow-ui";
import { kindLabels } from "../components/performance/flow-palette";
import {
  energyLabel,
  energyMethodNote,
  measurementNote,
  nodeEnergyLabel,
} from "../components/pricing/figures";

const flowSections = flows
  .map((flow) => {
    const keyFigures = flow.keyFigures
      .map((figure) => `| ${figure.label} | ${figure.value} |`)
      .join("\n");
    const timeSplit = flow.timeSplit
      .map((segment) => `| ${segment.label} | ${formatMs(segment.ms)} |`)
      .join("\n");
    const nodeRows = flow.nodes
      .map(
        (node) =>
          `| ${node.title} | ${kindLabels[node.kind]} | ${node.metric.label} | ${node.metric.value} |`,
      )
      .join("\n");
    const nodeDetails = flow.nodes
      .map((node) => {
        const rows = node.rows.map((row) => `| ${row.label} | ${row.value} |`).join("\n");
        const inputs = node.inputs?.map((port) => port.name).join(", ") || "None";
        const outputs = node.outputs?.map((port) => port.name).join(", ") || "None";
        return `### ${node.title}\n\n${node.note}\n\n| Field | Value |\n| --- | --- |\n${rows}\n\nIn: ${inputs}. Out: ${outputs}.`;
      })
      .join("\n\n");

    return `## ${flow.name}\n\n\`${flow.command}\`\n\n${flow.summary}\n\n| Key | Value |\n| --- | --- |\n${keyFigures}\n\n| Phase | Time |\n| --- | --- |\n${timeSplit}\n\n| Node | Kind | Metric | Value |\n| --- | --- | --- | --- |\n${nodeRows}\n\n${nodeDetails}`;
  })
  .join("\n\n");

const commandRows = commands
  .map(
    (entry) =>
      `| \`${entry.command}\` | ${secondsLabel(entry.p50)} | ${secondsLabel(entry.p95)} | ${memory(entry.memoryBytes)} | ${output(entry.outputBytes)} |`,
  )
  .join("\n");

const projectRows = projectSizes
  .map(
    (entry) =>
      `| ${count(entry.tasks)} | ${size(entry.databaseBytes)} | ${secondsLabel(entry.seconds)} | ${memory(entry.memoryBytes)} | ${output(entry.jsonBytes)} |`,
  )
  .join("\n");

export const GET: APIRoute = () =>
  new Response(
    `# Performance

The shape of a command.

Zinn runs when you call it, does its work and exits. These are the numbers for that round trip, and the path they take.

${fixture.tasks} tasks, 1 comment each. CLI ${fixture.cli}, ${fixture.platform}.

${flowSections}

## Commands

The 100-task fixture, one comment per task. p50, peak memory and output are measured for the first four commands. p95 and the last three commands are placeholders.

| Command | p50 | p95 | Peak memory | Output |
| --- | --- | --- | --- | --- |
${commandRows}

## Project size

The same list command as the board grows. The 100, 1,000 and 10,000-task rows are measured. The 100,000-task row is a placeholder.

| Tasks | Database | List time | Peak memory | JSON output |
| --- | --- | --- | --- | --- |
${projectRows}

## Storage

An empty database is ${size(storage.empty)}. A task adds about ${size(storage.task)} and a comment about ${size(storage.comment)}. At 10,000 tasks the file is ${size(storage.tenK)}. The 100,000-task placeholder lands near ${size(storage.hundredK)}.

The published packages download ${size(packages.download)}, unpack to ${size(packages.unpacked)} in ${count(packages.files)} files, and Zinn's own packages are ${size(packages.zinn)} of the download.

## Method

${measurementNote}

Node timings, p95, install timings, the extra commands and 100,000 tasks are placeholders. ${energyMethodNote} The read flow uses about ${energyLabel("zinn task list --json")} above idle, and Node accounts for ${nodeEnergyLabel}.

${mockNote}
`,
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  );
