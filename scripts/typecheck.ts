import ts from "typescript";
import { join } from "node:path";

import { listWorkingTreeFiles } from "./package-fixture.ts";

const repositoryDirectory = join(import.meta.dir, "..");
const project = process.argv[2];
const inspectorDirectory = "integrations/opencode/inspector/";
const codexDirectory = "integrations/codex/";

if (
  project !== undefined &&
  ![inspectorDirectory, codexDirectory].some((directory) => project === directory.slice(0, -1))
) {
  throw new Error(`Unknown TypeScript project: ${project}`);
}

const projectDirectory =
  project === undefined ? repositoryDirectory : join(repositoryDirectory, project);
const configPath = join(projectDirectory, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const files = listWorkingTreeFiles(repositoryDirectory).filter((path) => {
  const ownsFile =
    project === undefined
      ? !path.startsWith("docs/") &&
        !path.startsWith(inspectorDirectory) &&
        !path.startsWith(codexDirectory)
      : path.startsWith(project + "/");
  return ownsFile && /\.(?:[cm]?ts|tsx)$/.test(path);
});
const parsed = ts.parseJsonConfigFileContent(
  { ...config.config, files: files.map((path) => join(repositoryDirectory, path)), include: [] },
  ts.sys,
  projectDirectory,
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
