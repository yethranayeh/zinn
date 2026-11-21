import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// The site shows quotes and apostrophes as written, so sources use the straight forms
const curlyQuotes = /[‘’“”]/;
const sourceFolders = ["src/content", "src/releases", "src/pages", "src/components"];
const sourceExtensions = [".mdx", ".md", ".astro", ".ts"];

const sourceFiles = (await Promise.all(sourceFolders.map(async (folder) => {
  const directory = join(import.meta.dir, "..", folder);
  return (await readdir(directory, { recursive: true }))
    .filter((file) => sourceExtensions.some((extension) => file.endsWith(extension)))
    .map((file) => `${folder}/${file}`);
}))).flat();

test("the source folders hold files to check", () => {
  expect(sourceFiles.length).toBeGreaterThan(0);
});

test.each(sourceFiles)("%s has no curly quotes", async (file) => {
  const text = await Bun.file(join(import.meta.dir, "..", file)).text();
  const lineNumber = text.split("\n").findIndex((line) => curlyQuotes.test(line)) + 1;
  expect(lineNumber).toBe(0);
});
