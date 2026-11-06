import { randomUUID } from "node:crypto";
import { basename } from "node:path";

type OutputFileIdentity = {
  client: string;
  version: string;
};

/**
 * A file name without its extension: `<time>Z-<client>-<version>-<suffix>`.
 * The client ends before the first hyphen followed by a digit, where the version starts.
 */
const OUTPUT_FILE_STEM =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-(?<client>.+?)-(?<version>\d.*)-[0-9a-f]{8}$/;

/**
 * Names a file after the current UTC time, the client and its version, with a random suffix,
 *  so files written in the same second do not share a name.
 * Reading the name back needs a version that starts with a digit.
 * @param extension Includes the dot, as in `".log"`.
 * @example "2026-09-29T12-30-05Z-cli-0.32.0-b38178c0.log"
 */
export function createOutputFileName({ client, version }: OutputFileIdentity, extension: string) {
  // Colons are replaced because some filesystems refuse them in a name.
  const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const suffix = randomUUID().split("-")[0];

  return `${timestamp}Z-${client}-${version}-${suffix}${extension}`;
}

/** The client and version in the base name of `path`, or null when `createOutputFileName` did not name it. */
export function readOutputFileName(path: string, extension: string): OutputFileIdentity | null {
  const name = basename(path);

  if (!name.endsWith(extension)) {
    return null;
  }

  const stem = name.slice(0, name.length - extension.length);
  const match = OUTPUT_FILE_STEM.exec(stem)?.groups;

  if (match?.client == null || match.version == null) {
    return null;
  }

  return { client: match.client, version: match.version };
}
