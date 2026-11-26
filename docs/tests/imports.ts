import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");

const sourceFilePattern = "**/*.{astro,ts,mts,js,mjs,mdx}";
// Packages that ui components and Foundry may import. Relative imports are checked by folder.
const allowedPackages = ["astro/types", "tailwind-merge"];
// Matches the specifier in `from "x"`, `import "x"` and `import("x")`.
const importPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

export function sourceFilesIn(directory: string): string[] {
  return [...new Bun.Glob(sourceFilePattern).scanSync({ cwd: directory, absolute: true })];
}

export function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory + sep);
}

// Each import as written, with the file it resolves to when it is relative.
export function importsOf(file: string): { specifier: string; target?: string }[] {
  return [...readFileSync(file, "utf8").matchAll(importPattern)].map(([, specifier]) => {
    const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
    return {
      specifier,
      target: isRelative ? resolve(dirname(file), specifier.split("?")[0]) : undefined,
    };
  });
}

// Lists each import of the files in `directory` that resolves outside `allowedDirectories` or names a package not allowed.
export function importsOutside(directory: string, allowedDirectories: string[]): string[] {
  return sourceFilesIn(directory).flatMap((file) =>
    importsOf(file)
      .filter(({ specifier, target }) =>
        target === undefined
          ? !allowedPackages.includes(specifier)
          : !allowedDirectories.some((allowed) => isInside(target, allowed)),
      )
      .map(({ specifier }) => `${relative(docsDirectory, file)}: ${specifier}`),
  );
}
