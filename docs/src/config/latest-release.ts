import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The docs build and its tests run from docs/, while the inspector release test runs from the repository root.
const releaseRoots = ["src/releases", "docs/src/releases"];
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/;
const versionField = /^version:\s*"?([^"\r\n]+)"?\s*$/m;

function readVersion(file: string): string | undefined {
  const metadata = frontmatter.exec(readFileSync(file, "utf8"))?.[1];
  return metadata === undefined ? undefined : versionField.exec(metadata)?.[1];
}

function releaseDirectory(line: string): string {
  for (const root of releaseRoots) {
    const directory = join(process.cwd(), root, line);
    if (existsSync(directory)) {
      return directory;
    }
  }

  throw new Error(`No releases for ${line} under ${process.cwd()}`);
}

/** The highest version in a list, comparing each numeric part. */
export function latestVersion(versions: readonly string[]): string | undefined {
  return [...versions]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1);
}

/** The newest released version in a release line, read from its release notes. */
export function latestReleaseVersion(line: string): string {
  const directory = releaseDirectory(line);
  const versions = readdirSync(directory)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => readVersion(join(directory, file)))
    .filter((version): version is string => version !== undefined);

  const latest = latestVersion(versions);
  if (latest === undefined) {
    throw new Error(`No releases in ${directory}`);
  }

  return latest;
}
