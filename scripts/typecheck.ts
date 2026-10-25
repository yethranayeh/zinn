import ts from "typescript";
import { join } from "node:path";

import { listWorkingTreeFiles } from "./package-fixture.ts";

const repositoryDirectory = join(import.meta.dir, "..");
const configPath = join(repositoryDirectory, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const files = listWorkingTreeFiles(repositoryDirectory).filter(
  (path) => !path.startsWith("docs/") && /\.(?:[cm]?ts|tsx)$/.test(path),
);
const parsed = ts.parseJsonConfigFileContent(
  { ...config.config, files, include: [] },
  ts.sys,
  repositoryDirectory,
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [
  ...(config.error ? [config.error] : []),
  ...parsed.errors,
  ...ts.getPreEmitDiagnostics(program),
];

if (diagnostics.length > 0) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => repositoryDirectory,
      getNewLine: () => "\n",
    }),
  );
  process.exitCode = 1;
}
