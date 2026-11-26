import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const configPrograms = new Map<string, ts.Program>();
const printer = ts.createPrinter({ removeComments: true });
const indentUnit = "\t";
// Builds a property's shape from its resolved type when its declaration has no type to print.
const resolvedTypeFlags =
  ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.MultilineObjectLiterals |
  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope;

// Reads TypeShape's props from its MDX tag for pages that are rendered without MDX
export function typeShapeProps(tag: string) {
  const text = (name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const list = (name: string) => {
    const written = tag.match(new RegExp(`\\b${name}=\\{(\\[[^\\]]*\\])\\}`))?.[1];
    return written === undefined ? undefined : (JSON.parse(written) as Array<string>);
  };

  return {
    from: text("from")!,
    names: list("names")!,
    title: text("title")!,
    asWritten: list("asWritten"),
  };
}

// Prints the named exports of a repository TypeScript file as one TypeScript block
export function typeShape(from: string, names: Array<string>, asWritten: Array<string> = []) {
  const file = join(repositoryDirectory(), from);
  if (!existsSync(file)) {
    throw new Error(`TypeShape cannot find ${from}`);
  }
  const program = programFor(file);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(file)!;
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(sourceFile)!);

  return names
    .map((name) => {
      const exported = exports.find((symbol) => symbol.name === name);
      if (!exported) {
        throw new Error(`${from} does not export ${name}`);
      }

      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.declarations?.find(
        (node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node),
      ) as ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined;

      if (!declaration) {
        throw new Error(`${from} exports ${name}, which is not a type alias or interface`);
      }
      const isGeneric = (declaration.typeParameters?.length ?? 0) > 0;
      if (isGeneric || asWritten.includes(name)) {
        return writtenDeclaration(declaration);
      }
      const shape = ts.isTypeAliasDeclaration(declaration)
        ? printType(declaration.type, checker, "")
        : printProperties(checker.getDeclaredTypeOfSymbol(symbol), checker, "");
      return `type ${name} = ${shape};`;
    })
    .join("\n");
}

function repositoryDirectory() {
  let directory = process.cwd();

  while (!existsSync(join(directory, ".git"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("TypeShape runs inside the repository");
    }
    directory = parent;
  }

  return directory;
}

// One program per tsconfig.json, built from the files the pages name, as scripts/typecheck.ts builds its program.
function programFor(file: string) {
  const configPath = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  if (!configPath) {
    throw new Error(
      `TypeShape finds no tsconfig.json for ${relative(repositoryDirectory(), file)}`,
    );
  }

  const previous = configPrograms.get(configPath);
  if (previous?.getRootFileNames().includes(file)) {
    return previous;
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const files = [...(previous?.getRootFileNames() ?? []), file];
  const parsed = ts.parseJsonConfigFileContent(
    { ...config.config, files, include: [] },
    ts.sys,
    dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options, undefined, previous);
  configPrograms.set(configPath, program);

  return program;
}

// The declaration as its source writes it, indented with tabs.
function writtenDeclaration(declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration) {
  const lines = declaration
    .getText()
    .replace(/^export\s+/, "")
    .split("\n");
  const indents = lines
    .slice(1)
    .map((line) => line.match(/^ */)![0].length)
    .filter((width) => width > 0);
  const width = Math.min(...indents);

  return lines
    .map((line) => {
      const leading = line.match(/^ */)![0].length;
      return indents.length > 0 ? indentUnit.repeat(leading / width) + line.slice(leading) : line;
    })
    .join("\n");
}

function printType(node: ts.TypeNode, checker: ts.TypeChecker, indent: string): string {
  if (ts.isTypeLiteralNode(node)) {
    return printMembers(node.members, checker, indent);
  }

  if (ts.isUnionTypeNode(node)) {
    return node.types.map((type) => printType(type, checker, indent)).join(" | ");
  }

  if (ts.isIntersectionTypeNode(node)) {
    return node.types.map((type) => printType(type, checker, indent)).join(" & ");
  }

  if (ts.isArrayTypeNode(node)) {
    return `${printType(node.elementType, checker, indent)}[]`;
  }

  if (ts.isParenthesizedTypeNode(node)) {
    return `(${printType(node.type, checker, indent)})`;
  }

  if (ts.isTypeReferenceNode(node)) {
    if (expandsReference(node, checker)) {
      return printProperties(checker.getTypeFromTypeNode(node), checker, indent);
    }

    const name = printNode(node.typeName);
    const typeArguments = node.typeArguments?.map((type) => printType(type, checker, indent));
    return typeArguments ? `${name}<${typeArguments.join(", ")}>` : name;
  }

  return printNode(node);
}

// A utility type from TypeScript or a dependency, such as Pick or z.infer, shows the object it produces
function expandsReference(node: ts.TypeReferenceNode, checker: ts.TypeChecker) {
  const referenced = checker.getSymbolAtLocation(node.typeName);
  const symbol =
    referenced && referenced.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(referenced)
      : referenced;
  const declaredOutsideRepository = symbol?.declarations?.some((declaration) => {
    const fileName = declaration.getSourceFile().fileName;
    return fileName.includes("/node_modules/") || declaration.getSourceFile().hasNoDefaultLib;
  });
  const type = checker.getTypeFromTypeNode(node);
  const isPlainObject =
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    checker.getIndexInfosOfType(type).length === 0 &&
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0 &&
    !checker.isArrayType(type);

  return Boolean(declaredOutsideRepository) && isPlainObject;
}

function printMembers(members: readonly ts.TypeElement[], checker: ts.TypeChecker, indent: string) {
  const inner = indent + indentUnit;
  const lines = members.map((member) => {
    if (ts.isPropertySignature(member) && member.type) {
      return `${inner}${propertyHead(member)}: ${printType(member.type, checker, inner)};`;
    }
    return `${inner}${printNode(member)}`;
  });

  return `{\n${lines.join("\n")}\n${indent}}`;
}

// Prints a resolved object type, keeping each property's type as its declaration writes it.
function printProperties(type: ts.Type, checker: ts.TypeChecker, indent: string) {
  const inner = indent + indentUnit;
  const lines = checker.getPropertiesOfType(type).map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyType = checker.getTypeOfSymbol(property);
    const writtenType =
      declaration && ts.isPropertySignature(declaration) && declaration.type
        ? declaration.type
        : undefined;
    // An optional property's resolved type adds undefined to the written one.
    const matchesWritten =
      writtenType !== undefined &&
      [propertyType, checker.getNonNullableType(propertyType)].includes(
        checker.getTypeFromTypeNode(writtenType),
      );
    const isOptional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    const isReadonly =
      declaration !== undefined &&
      ts.isPropertySignature(declaration) &&
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
    const head = `${isReadonly ? "readonly " : ""}${property.name}${isOptional ? "?" : ""}`;
    const shape = matchesWritten
      ? printType(writtenType!, checker, inner)
      : printType(
          checker.typeToTypeNode(
            isOptional ? checker.getNonNullableType(propertyType) : propertyType,
            undefined,
            resolvedTypeFlags,
          )!,
          checker,
          inner,
        );
    return `${inner}${head}: ${shape};`;
  });

  return `{\n${lines.join("\n")}\n${indent}}`;
}

function propertyHead(member: ts.PropertySignature) {
  const isReadonly = member.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
  );

  return `${isReadonly ? "readonly " : ""}${printNode(member.name)}${member.questionToken ? "?" : ""}`;
}

function printNode(node: ts.Node) {
  const sourceFile =
    node.getSourceFile?.() ?? ts.createSourceFile("shape.ts", "", ts.ScriptTarget.Latest);

  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}
