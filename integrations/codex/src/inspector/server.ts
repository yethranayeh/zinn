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

const settings = loadSettings();
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

  async ({ key }) => {
    const result = readTask(settings, key, true);
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
    structuredContent: { ...readRecent(settings, extra._meta, true) },
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

await server.connect(new StdioServerTransport());
