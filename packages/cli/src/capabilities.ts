import type { Command } from "./types.js";

import { invocation } from "./input.js";
import { generateResultSchemas } from "./result-schemas.js";
import { parsedRoutes } from "./routes/routes.js";

import packageJson from "../package.json" with { type: "json" };

export type Capabilities = {
  manifestVersion: 1;
  cli: { name: string; version: string };
  invocation: typeof invocation;
  commands: Array<
    Pick<Command, "summary" | "input" | "effects" | "confirmation" | "results"> & { path: string[] }
  >;
  error: { schemaRef: "#/schemas/definitions/ErrorEnvelope"; exitCode: 1; stream: "stderr" };
  schemas: ReturnType<typeof generateResultSchemas>;
};

export function getCapabilitySummary() {
  return {
    cli: { name: packageJson.name, version: packageJson.version },
    commandCount: parsedRoutes.length,
    manifestVersion: 1,
  };
}

export function generateCapabilities(): Capabilities {
  const { cli } = getCapabilitySummary();

  return {
    manifestVersion: 1,
    cli,
    invocation,
    commands: parsedRoutes.map(({ command, summary, input, effects, confirmation, results }) => ({
      path: command.split(" "),
      summary,
      input,
      effects,
      confirmation,
      results,
    })),
    error: { schemaRef: "#/schemas/definitions/ErrorEnvelope", exitCode: 1, stream: "stderr" },
    schemas: generateResultSchemas(),
  };
}
