import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import { loadSettings } from "../settings";
import { INSPECTOR_VERSION } from "../runtime";
import { readTask } from "./task-reader";
import { readRecent } from "./references";
import { createCliReader } from "../shared/cli";

const settings = loadSettings();
const reader = createCliReader(settings);
const resourceUri = `ui://zinn/inspector-${INSPECTOR_VERSION}.html`;
const server = new McpServer({ name: "zinn", version: INSPECTOR_VERSION });
registerAppTool(
  server,
  "inspect_task",
  {
    title: "Zinn task inspector",
    description:
      "Read task details from the selected local Zinn database. Open without a key for manual lookup.",
    inputSchema: { key: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri, visibility: ["app"] },
      "openai/ui": { entrypoints: [{ type: "thread" }] },
    },
  },

  async ({ key }, extra) => {
    const result = await readTask(settings, key, reader, extra.signal);
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
