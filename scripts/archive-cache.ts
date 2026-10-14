import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Reuses a verified download, or downloads, checks and saves a replacement. */
export async function readVerifiedDownload(
  cachePath: string,
  expectedHash: string,
  download: (temporaryPath: string) => Promise<unknown>,
) {
  const matchesChecksum = (downloadBytes: Buffer) =>
    createHash("sha256").update(downloadBytes).digest("hex") === expectedHash;
  if (existsSync(cachePath)) {
    const downloadBytes = readFileSync(cachePath);
    if (matchesChecksum(downloadBytes)) {
      return downloadBytes;
    }
    rmSync(cachePath, { force: true });
  }

  const cacheDirectory = dirname(cachePath);
  mkdirSync(cacheDirectory, { recursive: true });
  // Use the cache filesystem so rename exposes only a complete, verified download.
  const temporaryDirectory = mkdtempSync(join(cacheDirectory, ".download-"));
  const temporaryPath = join(temporaryDirectory, basename(cachePath));
  try {
    await download(temporaryPath);
    const downloadBytes = readFileSync(temporaryPath);
    assert.ok(matchesChecksum(downloadBytes), `Checksum mismatch: ${basename(cachePath)}`);
    renameSync(temporaryPath, cachePath);
    return downloadBytes;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
