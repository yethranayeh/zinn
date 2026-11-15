import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { alignmentEdgeOf, gapOf, parsePlacement } from "../foundry/inspector/drafting";
import {
  cropFor,
  fitCrop,
  rectInPlate,
  slotCapacity,
  slotStops,
} from "../foundry/inspector/plates";

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

// `:focus\b` also matches :focus-visible and :focus-within.
// A style-block comment that names a forbidden token will trip the scan.
const forbiddenStyleCss = [
  /:hover\b/,
  /:focus\b/,
  /:active\b/,
  /:disabled\b/,
  /@media\s*\(\s*hover/,
  /prefers-reduced-motion/,
  /\btransition(?:-[\w-]+)?\s*:/,
  /\banimation(?:-[\w-]+)?\s*:/,
];

test("ui style blocks contain no hand-written state, transition or animation CSS", () => {
  const violations = sourceFilesIn(uiDirectory)
    .filter((file) => file.endsWith(".astro"))
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].flatMap(([, css]) =>
        forbiddenStyleCss.flatMap((pattern) => {
          const match = css.match(pattern);
          return match ? [`${relative(docsDirectory, file)}: ${match[0]}`] : [];
        }),
      );
    });

  expect(violations).toEqual([]);
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

test("the built tooltip page hosts its placements in the inspector, off by default", () => {
  const page = readFileSync(join(foundryBuildDirectory, "tooltip", "index.html"), "utf8");
  expect(page).toContain("data-stage-shell");
  expect(page).toContain('data-inspecting="off"');
});

test("the inspector reads a tooltip placement's side and alignment", () => {
  expect(parsePlacement("bottom-end")).toEqual({
    value: "bottom-end",
    side: "bottom",
    align: "end",
  });
  expect(parsePlacement("left-center")).toEqual({
    value: "left-center",
    side: "left",
    align: "center",
  });
  expect(parsePlacement(null)).toEqual({ value: "bottom-end", side: "bottom", align: "end" });
});

test("the inspector measures the tooltip gap on the placement side", () => {
  const trigger = { x: 100, y: 100, w: 44, h: 44 };

  expect(gapOf(trigger, { x: 100, y: 151, w: 137, h: 33 }, "bottom")).toBe(7);
  expect(gapOf(trigger, { x: 100, y: 50, w: 137, h: 33 }, "top")).toBe(17);
  expect(gapOf(trigger, { x: 0, y: 100, w: 93, h: 33 }, "left")).toBe(7);
  expect(gapOf(trigger, { x: 151, y: 100, w: 137, h: 33 }, "right")).toBe(7);
});

test("the inspector picks the aligned edge on the placement axis", () => {
  const content = { x: 100, y: 151, w: 137, h: 33 };

  expect(alignmentEdgeOf(content, "bottom", "start")).toBe(100);
  expect(alignmentEdgeOf(content, "bottom", "center")).toBe(168.5);
  expect(alignmentEdgeOf(content, "bottom", "end")).toBe(237);
  expect(alignmentEdgeOf(content, "left", "start")).toBe(151);
  expect(alignmentEdgeOf(content, "left", "center")).toBe(167.5);
  expect(alignmentEdgeOf(content, "left", "end")).toBe(184);
});

test("the tab trace crop covers the focus ring and any open tooltip", () => {
  const surface = { w: 400, h: 300 };
  const focus = { x: 100, y: 100, w: 44, h: 44 };

  expect(cropFor(focus, null, surface)).toEqual({ x: 92, y: 92, w: 60, h: 60 });
  expect(cropFor(focus, { x: 151, y: 151, w: 137, h: 33 }, surface)).toEqual({
    x: 92,
    y: 92,
    w: 204,
    h: 100,
  });
  expect(cropFor({ x: 0, y: 0, w: 44, h: 44 }, null, surface)).toEqual({ x: 0, y: 0, w: 52, h: 52 });
  expect(cropFor({ x: 100, y: 60, w: 44, h: 44 }, null, { w: 300, h: 100 })).toEqual({
    x: 92,
    y: 52,
    w: 60,
    h: 48,
  });
});

test("a plate fits its crop without distortion and stays centred", () => {
  const wide = fitCrop({ x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, w: 100, h: 56 }, 2);
  expect(wide.scale).toBeCloseTo(0.48, 5);
  expect(wide).toEqual({ x: 2, y: 4, w: 96, h: 48, scale: 0.48 });

  const tall = fitCrop({ x: 0, y: 0, w: 100, h: 200 }, { x: 0, y: 0, w: 100, h: 56 }, 2);
  expect(tall.scale).toBeCloseTo(0.26, 5);
  expect(tall.x).toBeCloseTo(37, 5);
  expect(tall.y).toBeCloseTo(2, 5);
  expect(tall.w).toBeCloseTo(26, 5);
  expect(tall.h).toBeCloseTo(52, 5);
});

test("a plate maps the focused box with its crop", () => {
  const crop = { x: 100, y: 0, w: 200, h: 100 };
  const fit = fitCrop(crop, { x: 0, y: 0, w: 100, h: 56 }, 2);
  const mapped = rectInPlate({ x: 100, y: 20, w: 40, h: 40 }, crop, fit);

  expect(mapped.x).toBeCloseTo(2, 5);
  expect(mapped.y).toBeCloseTo(13.6, 5);
  expect(mapped.w).toBeCloseTo(19.2, 5);
  expect(mapped.h).toBeCloseTo(19.2, 5);
});

test("the strip fits fixed slots and reuses them in order", () => {
  expect(slotCapacity(216)).toBe(2);
  expect(slotCapacity(50)).toBe(1);
  expect(slotCapacity(400)).toBe(3);
  expect(slotCapacity(4000)).toBe(6);

  expect(slotStops([1, 2, 3], 6)).toEqual([1, 2, 3]);
  expect(slotStops([1, 2, 3, 4, 5, 6, 7], 6)).toEqual([2, 3, 4, 5, 6, 7]);
  expect(slotStops([1, 2, 3, 4, 5, 6, 7, 8, 9], 2)).toEqual([8, 9]);
  expect(slotStops([1, 2], 0)).toEqual([2]);
});

test("Foundry's build holds exactly the pages in foundry/pages", () => {
  const expectedPages = [...new Bun.Glob("**/*.astro").scanSync({ cwd: foundryPagesDirectory })]
    .map((page) => page.slice(0, -".astro".length))
    .map((route) => (route === "index" || route.endsWith("/index") ? `${route}.html` : `${route}/index.html`))
    .sort();
  const builtPages = [...new Bun.Glob("**/*.html").scanSync({ cwd: foundryBuildDirectory })].sort();
  expect(builtPages).toEqual(expectedPages);
});

test("Foundry's build copies only the listed files from public", async () => {
  const { shippedPublicFiles } = await import("../foundry.config.mjs");
  const publicFiles = [...new Bun.Glob("**/*").scanSync({ cwd: join(docsDirectory, "public"), dot: true })];
  // Foundry writes its own _headers.
  const copiedFiles = publicFiles
    .filter((file) => file !== "_headers" && existsSync(join(foundryBuildDirectory, file)))
    .sort();
  expect(copiedFiles).toEqual([...shippedPublicFiles].sort());
});

test("every path Foundry's pages and styles reference exists in its build", () => {
  // Matches root-relative paths in attributes and in CSS url().
  const referencePattern = /(?:(?:href|src)="|url\(["']?)(\/[^"'#?)\s]*)/g;
  const builtFiles = [...new Bun.Glob("**/*.{html,css}").scanSync({ cwd: foundryBuildDirectory, absolute: true })];
  const missingPaths = builtFiles.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(referencePattern)]
      .map(([, path]) => (path.endsWith("/") ? `${path}index.html` : path))
      .filter((path) => !existsSync(join(foundryBuildDirectory, path)))
      .map((path) => `${relative(foundryBuildDirectory, file)}: ${path}`),
  );
  expect(missingPaths).toEqual([]);
});

test("Foundry's build serves the headers from foundry/_headers", () => {
  expect(readFileSync(join(foundryBuildDirectory, "_headers"), "utf8")).toBe(readFileSync(join(foundryDirectory, "_headers"), "utf8"));
});

test("every Foundry page asks search engines not to index it", () => {
  const pagesWithoutNoindex = [...new Bun.Glob("**/*.html").scanSync({ cwd: foundryBuildDirectory })].filter(
    (page) => !readFileSync(join(foundryBuildDirectory, page), "utf8").includes('<meta name="robots" content="noindex">'),
  );
  expect(pagesWithoutNoindex).toEqual([]);
});
