import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readVerifiedDownload } from "./archive-cache.ts";

const DOWNLOAD_DATA = Buffer.from("complete archive bytes");
const INCOMPLETE_DOWNLOAD_DATA = DOWNLOAD_DATA.subarray(0, DOWNLOAD_DATA.length / 2);
const DOWNLOAD_HASH = createHash("sha256").update(DOWNLOAD_DATA).digest("hex");
const CHILD_READY_TIMEOUT_MS = 5_000;
const CHILD_POLL_INTERVAL_MS = 10;
const TRANSFER_HOLD_MS = 60_000;

test("verified downloads are reused and incomplete cached files are replaced", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-archive-cache-"));
  const cachePath = join(root, "archive.tar.xz");
  let downloads = 0;
  try {
    writeFileSync(cachePath, INCOMPLETE_DOWNLOAD_DATA);
    const download = async (temporaryPath: string) => {
      downloads++;
      expect(existsSync(cachePath)).toBe(false);
      writeFileSync(temporaryPath, INCOMPLETE_DOWNLOAD_DATA);
      expect(existsSync(cachePath)).toBe(false);
      writeFileSync(temporaryPath, DOWNLOAD_DATA);
    };
    expect(await readVerifiedDownload(cachePath, DOWNLOAD_HASH, download)).toEqual(DOWNLOAD_DATA);
    expect(readFileSync(cachePath)).toEqual(DOWNLOAD_DATA);
    expect(downloads).toBe(1);
    expect(await readVerifiedDownload(cachePath, DOWNLOAD_HASH, download)).toEqual(DOWNLOAD_DATA);
    expect(downloads).toBe(1);
    expect(readdirSync(root)).toEqual(["archive.tar.xz"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed downloads and incorrect checksums never leave a final cached file", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-archive-failure-"));
  const cachePath = join(root, "archive.tar.xz");
  try {
    await expect(readVerifiedDownload(cachePath, DOWNLOAD_HASH, async (temporaryPath) => {
      writeFileSync(temporaryPath, INCOMPLETE_DOWNLOAD_DATA);
      throw new Error("download failed");
    })).rejects.toThrow();
    expect(existsSync(cachePath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);

    await expect(readVerifiedDownload(cachePath, DOWNLOAD_HASH, async (temporaryPath) => {
      writeFileSync(temporaryPath, "wrong bytes");
    })).rejects.toThrow();
    expect(existsSync(cachePath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);

    await readVerifiedDownload(cachePath, DOWNLOAD_HASH, async (temporaryPath) => {
      writeFileSync(temporaryPath, DOWNLOAD_DATA);
    });
    expect(readFileSync(cachePath)).toEqual(DOWNLOAD_DATA);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted download can be retried on the next run", async () => {
  const root = mkdtempSync(join(tmpdir(), "zinn-archive-interrupted-"));
  const cacheDirectory = join(root, "cache");
  const cachePath = join(cacheDirectory, "archive.tar.xz");
  const readyPath = join(root, "ready");
  const module = fileURLToPath(new URL("archive-cache.ts", import.meta.url));
  mkdirSync(cacheDirectory);
  const child = Bun.spawn([process.execPath, "--eval", `
    import { writeFileSync } from "node:fs";
    import { readVerifiedDownload } from ${JSON.stringify(module)};
    await readVerifiedDownload(${JSON.stringify(cachePath)}, ${JSON.stringify(DOWNLOAD_HASH)}, async (path) => {
      writeFileSync(path, "incomplete transfer");
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      await Bun.sleep(${TRANSFER_HOLD_MS});
    });
  `], { stdout: "pipe", stderr: "pipe" });

  try {
    const deadline = performance.now() + CHILD_READY_TIMEOUT_MS;
    while (!existsSync(readyPath) && child.exitCode === null && performance.now() < deadline) {
      await Bun.sleep(CHILD_POLL_INTERVAL_MS);
    }
    expect(existsSync(readyPath)).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(existsSync(cachePath)).toBe(false);

    await readVerifiedDownload(cachePath, DOWNLOAD_HASH, async (temporaryPath) => {
      writeFileSync(temporaryPath, DOWNLOAD_DATA);
    });
    expect(readFileSync(cachePath)).toEqual(DOWNLOAD_DATA);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    rmSync(root, { recursive: true, force: true });
  }
});
