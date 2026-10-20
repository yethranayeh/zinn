import type { ParsedRoute } from "./types.js";

import { invocation } from "./input.js";
import { generateResultSchemas } from "./result-schemas.js";
import { parsedRoutes } from "./routes/routes.js";

import packageJson from "../package.json" with { type: "json" };

export type Capabilities = {
  manifestVersion: 1;
  cli: { name: string; version: string };
  invocation: typeof invocation;
  commands: Array<
    Pick<ParsedRoute, "aliases" | "summary" | "input" | "effects" | "confirmation" | "results"> & {
      path: Array<string>;
    }
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
    commands: parsedRoutes.map(
      ({ command, aliases, summary, input, effects, confirmation, results }) => ({
        path: command.split(" "),
        aliases,
        summary,
        input,
        effects,
        confirmation,
        results,
      }),
    ),
    error: { schemaRef: "#/schemas/definitions/ErrorEnvelope", exitCode: 1, stream: "stderr" },
    schemas: generateResultSchemas(),
  };
}
