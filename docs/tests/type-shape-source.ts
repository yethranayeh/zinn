import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const repositoryDirectory = resolve(import.meta.dir, "../..");

// Property names of an exported type, read with the compiler, independently of TypeShape
export function exportedPropertyNames(from: string, name: string) {
  const file = join(repositoryDirectory, from);
  const configPath = ts.findConfigFile(dirname(file), ts.sys.fileExists)!;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    { ...config.config, files: [file], include: [] },
    ts.sys,
    dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const exported = checker
    .getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)!)!)
    .find((symbol) => symbol.name === name)!;
  const symbol =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  return checker
    .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))
    .map((property) => property.name);
}
