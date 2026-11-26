import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { importsOf, importsOutside, isInside, sourceFilesIn } from "./imports";

// Rules for the shared ui components and the import direction between zinn.sh, ui and Foundry. They read source only.
const docsDirectory = resolve(import.meta.dir, "..");
const sourceDirectory = join(docsDirectory, "src");
const uiDirectory = join(sourceDirectory, "components/ui");
const stylesDirectory = join(sourceDirectory, "styles");
const foundryDirectory = join(docsDirectory, "foundry");

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
