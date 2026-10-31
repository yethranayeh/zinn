import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const docsDirectory = resolve(import.meta.dir, "..");
const sourceDirectory = join(docsDirectory, "src");
const uiDirectory = join(sourceDirectory, "components/ui");
const stylesDirectory = join(sourceDirectory, "styles");
const foundryDirectory = join(docsDirectory, "foundry");
const foundryPagesDirectory = join(foundryDirectory, "pages");
const proposedDirectory = join(foundryDirectory, "proposed");
const foundryBuildDirectory = join(docsDirectory, "dist-foundry");

const sourceFilePattern = "**/*.{astro,ts,mts,js,mjs,mdx}";
// Packages that ui components and Foundry may import. Relative imports are checked by folder.
const allowedPackages = ["astro/types", "tailwind-merge"];
// Matches the specifier in `from "x"`, `import "x"` and `import("x")`.
const importPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

const uiFolders = readdirSync(uiDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const proposedFolders = readdirSync(proposedDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function sourceFilesIn(directory: string): string[] {
  return [...new Bun.Glob(sourceFilePattern).scanSync({ cwd: directory, absolute: true })];
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory + sep);
}

// Each import as written, with the file it resolves to when it is relative.
function importsOf(file: string): { specifier: string; target?: string }[] {
  return [...readFileSync(file, "utf8").matchAll(importPattern)].map(([, specifier]) => {
    const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
    return { specifier, target: isRelative ? resolve(dirname(file), specifier.split("?")[0]) : undefined };
  });
}

// Lists each import of the files in `directory` that resolves outside `allowedDirectories` or names a package not allowed.
function importsOutside(directory: string, allowedDirectories: string[]): string[] {
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

test.each(uiFolders)("src/components/ui/%s has a Foundry page", (folder) => {
  expect(existsSync(join(foundryPagesDirectory, `${folder}.astro`))).toBe(true);
});

test.each(uiFolders.filter((folder) => existsSync(join(uiDirectory, folder, "variants.ts"))))(
  "the Foundry page for src/components/ui/%s reads its variants.ts",
  (folder) => {
    const variantsFile = join(uiDirectory, folder, "variants.ts");
    const pageImports = importsOf(join(foundryPagesDirectory, `${folder}.astro`));
    expect(pageImports.some(({ target }) => target === variantsFile || target === variantsFile.slice(0, -".ts".length))).toBe(true);
  },
);

test("ui components import only other ui components, Astro types and tailwind-merge", () => {
  expect(importsOutside(uiDirectory, [uiDirectory])).toEqual([]);
});

test("Foundry imports only ui components, styles and its own files", () => {
  expect(importsOutside(foundryDirectory, [foundryDirectory, uiDirectory, stylesDirectory])).toEqual([]);
});

test("nothing in src imports Foundry", () => {
  const foundryImports = sourceFilesIn(sourceDirectory).flatMap((file) =>
    importsOf(file)
      .filter(({ target }) => target !== undefined && isInside(target, foundryDirectory))
      .map(({ specifier }) => `${relative(docsDirectory, file)}: ${specifier}`),
  );
  expect(foundryImports).toEqual([]);
});

test.each(proposedFolders)("foundry/proposed/%s has a Foundry page", (folder) => {
  expect(existsSync(join(foundryPagesDirectory, "proposed", `${folder}.astro`))).toBe(true);
});

test.each(proposedFolders)("the built page for foundry/proposed/%s shows the Proposed tag", (folder) => {
  const page = readFileSync(join(foundryBuildDirectory, "proposed", folder, "index.html"), "utf8");
  expect(page).toContain('data-status="proposed"');
});

test.each(uiFolders)("the built page for src/components/ui/%s shows no Proposed tag", (folder) => {
  const page = readFileSync(join(foundryBuildDirectory, folder, "index.html"), "utf8");
  expect(page).not.toContain('data-status="proposed"');
});

test("Foundry's build holds exactly the pages in foundry/pages", () => {
  const expectedPages = [...new Bun.Glob("**/*.astro").scanSync({ cwd: foundryPagesDirectory })]
    .map((page) => page.slice(0, -".astro".length))
    .map((route) => (route === "index" || route.endsWith("/index") ? `${route}.html` : `${route}/index.html`))
    .sort();
  const builtPages = [...new Bun.Glob("**/*.html").scanSync({ cwd: foundryBuildDirectory })].sort();
  expect(builtPages).toEqual(expectedPages);
});
