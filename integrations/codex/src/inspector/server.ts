import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import { loadSettings, resolveSettings } from "../settings";
import { INSPECTOR_VERSION } from "../runtime";
import { readInspectorTask, rememberSelection } from "./selection";
import {
  createHumanActionReader,
  editTask,
  moveTask,
  readTaskColumns,
  readTaskEditOptions,
} from "./task-actions";
import { readRecent } from "./references";
import { createCliReader } from "../shared/cli";

const startup = new AbortController();
const cancelStartup = () => startup.abort();

process.once("SIGTERM", cancelStartup);
process.once("SIGINT", cancelStartup);

const { settings } = await resolveSettings(loadSettings(), { signal: startup.signal });

startup.signal.throwIfAborted();
process.removeListener("SIGTERM", cancelStartup);
process.removeListener("SIGINT", cancelStartup);

const reader = createCliReader(settings);
const humanActionReader = createHumanActionReader(settings);
const resourceUri = `ui://zinn/inspector-${INSPECTOR_VERSION}.html`;
const server = new McpServer({ name: "zinn", version: INSPECTOR_VERSION });
registerAppTool(
  server,
  "inspect_task",
  {
    title: "Zinn task inspector",
    description:
      "Read task details from the selected local Zinn database. Open without a key to restore this chat and store's selection.",
    inputSchema: { key: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri, visibility: ["app"] },
      "openai/ui": { entrypoints: [{ type: "thread" }] },
    },
  },

  async ({ key }, extra) => {
    const result = await readInspectorTask(settings, key, reader, extra._meta, extra.signal);
    return {
      content: [
        {
          type: "text",
          text:
            result.kind === "ready"
              ? `Read ${result.task!.key}.`
              : (result.error ?? "Zinn task inspector ready."),
        },
      ],
      structuredContent: { ...result },
    };
  },
);

registerAppTool(
  server,
  "remember_selection",
  {
    title: "Remember selected task",
    description:
      "Save only the selected task key for this chat and selected store in local integration state.",
    inputSchema: { key: z.string(), expectedScope: z.string() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ key, expectedScope }, extra) => ({
    content: [],
    structuredContent: extra.signal.aborted
      ? { saved: false, warning: "Selection was not remembered because the request was cancelled." }
      : { ...rememberSelection(settings, key, expectedScope, extra._meta) },
  }),
);

registerAppTool(
  server,
  "task_columns",
  {
    title: "List task columns",
    description: "Read the columns in the selected task's project.",
    inputSchema: { key: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ key }, extra) => {
    const result = await readTaskColumns(settings, key, reader, extra.signal);
    return {
      content: [
        {
          type: "text",
          text: result.kind === "ready" ? `Read columns for ${result.key}.` : result.error!,
        },
      ],
      structuredContent: result,
    };
  },
);

registerAppTool(
  server,
  "move_task",
  {
    title: "Move task",
    description: "Move the selected task to a column in its project.",
    inputSchema: { key: z.string(), column: z.string() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ key, column }, extra) => {
    const result = await moveTask(settings, key, column, humanActionReader, extra.signal);
    return {
      content: [
        {
          type: "text",
          text:
            result.kind === "error"
              ? result.error!
              : result.changed
                ? `Moved ${result.key}.`
                : `${result.key} was already in the ${result.task!.column} column.`,
        },
      ],
      structuredContent: result,
    };
  },
);

registerAppTool(
  server,
  "task_edit_options",
  {
    title: "Read task edit options",
    description: "Read task priority choices from the configured Zinn CLI's capabilities.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  async (_args, extra) => ({
    content: [],
    structuredContent: { ...(await readTaskEditOptions(reader, extra.signal)) },
  }),
);

registerAppTool(
  server,
  "edit_task",
  {
    title: "Edit task",
    description: "Save changed title, description or priority fields on the selected task.",
    inputSchema: {
      key: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.string().nullable().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ key, ...edits }, extra) => {
    const result = await editTask(settings, key, edits, humanActionReader, extra.signal);
    return {
      content: [
        { type: "text", text: result.kind === "error" ? result.error! : `Saved ${result.key}.` },
      ],
      structuredContent: result,
    };
  },
);

registerAppTool(
  server,
  "recent_tasks",
  {
    title: "Recent tasks in this chat",
    description:
      "Read this chat's observed task references from host request metadata and the selected local database.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  async (_args, extra) => ({
    content: [],
    structuredContent: { ...(await readRecent(settings, reader, extra._meta, extra.signal)) },
  }),
);

registerAppResource(server, "Zinn task inspector", resourceUri, {}, async () => ({
  contents: [
    {
      uri: resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL("./widget.html", import.meta.url), "utf8"),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    },
  ],
}));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await reader.close();
  await humanActionReader.close();
  await server.close();
  process.stdin.pause();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());
process.stdout.once("error", () => void shutdown());
server.server.onclose = () => void shutdown();

await server.connect(new StdioServerTransport());
