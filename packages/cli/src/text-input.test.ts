import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { MAX_TEXT_BYTES } from "@zinn-dev/core";

import { CliError, errorDocumentSchema } from "./errors";
import { resolveTextInput } from "./text-input";

const READER_URL = new URL("./text-input.ts", import.meta.url).href;
const LIB_URL = new URL("./lib.ts", import.meta.url).href;
const SUBPROCESS_TIMEOUT_MS = 5_000;
const isPosix = process.platform !== "win32";

async function withDirectory(action: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-text-input-"));
  try {
    await action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withStdin(input: Readable & { isTTY?: boolean }, action: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  try {
    await action();
  } finally {
    Object.defineProperty(process, "stdin", descriptor);
    input.destroy();
  }
}

function runReader(directory: string, path: string, input = Buffer.alloc(0)) {
  const program = `
    import { resolveTextInput } from ${JSON.stringify(READER_URL)};
    import { prepareOutput, renderFailure } from ${JSON.stringify(LIB_URL)};
    prepareOutput(['--json']);
    try {
      console.log(JSON.stringify(await resolveTextInput(undefined, ${JSON.stringify(path)}, '--description')));
    } catch (error) {
      renderFailure(error);
    }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", program], {
    cwd: directory,
    env: { ...TEST_ENVIRONMENT, ZINN_DIR: join(directory, "store") },
    stdin: input,
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  expect(existsSync(join(directory, "store"))).toBe(false);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("inline input stays unchanged and conflicting sources fail before reading", async () => {
  for (const flag of ["--description", "--text"] as const) {
    expect(await resolveTextInput(undefined, undefined, flag)).toBeUndefined();
    for (const text of ["", " \t\n", "literal\r\n\0text\n"]) {
      expect(await resolveTextInput(text, undefined, flag)).toBe(text);
      await expect(resolveTextInput(text, "missing-file", flag)).rejects.toMatchObject({
        code: "invalid_input",
        details: { argument: `${flag}-file`, path: "missing-file" },
      });
    }
    await withStdin(Object.assign(new Readable({ read() {} }), { isTTY: true }), async () => {
      await expect(resolveTextInput("inline", "-", flag)).rejects.toMatchObject({
        code: "invalid_input",
        details: { argument: `${flag}-file` },
      });
    });
  }
});

test("file and real pipe input preserve literal UTF-8 and remove only trailing line breaks", async () => {
  const cases = [
    ['  - "quotes" {"json":true} \\path $(touch sentinel) `command`\n\t😀 日本語  \n\n', '  - "quotes" {"json":true} \\path $(touch sentinel) `command`\n\t😀 日本語  '],
    ["one\r\ntwo\r\n\r\n", "one\r\ntwo"],
    ["one\n\r\n\n", "one"],
    ["one\r", "one\r"],
    ["one\r\r\n", "one\r"],
    ["one\n \t", "one\n \t"],
    ["\uFEFFBOM\n", "BOM"],
    ["a\uFEFFb", "a\uFEFFb"],
    ["valid replacement character: \uFFFD", "valid replacement character: \uFFFD"],
  ];
  await withDirectory(async (directory) => {
    const path = join(directory, "input.md");
    for (const [source, expected] of cases) {
      const bytes = Buffer.from(source!);
      writeFileSync(path, bytes);
      expect(await resolveTextInput(undefined, path, "--description")).toBe(expected!);
      const pipe = runReader(directory, "-", bytes);
      expect(pipe.code, pipe.stderr).toBe(0);
      expect(JSON.parse(pipe.stdout)).toBe(expected!);
      expect(pipe.stderr).toBe("");
      expect(readFileSync(path)).toEqual(bytes);
    }
    expect(existsSync(join(directory, "sentinel"))).toBe(false);
  });
});

test("native absolute and relative paths accept spaces, Unicode and leading hyphens", async () => {
  await withDirectory(async (directory) => {
    for (const name of ["space name.md", "日本語 😀.md", "-input.md"]) {
      const path = join(directory, name);
      writeFileSync(path, "literal text");
      expect(await resolveTextInput(undefined, path, "--text")).toBe("literal text");
      expect(await resolveTextInput(undefined, relative(process.cwd(), path), "--text")).toBe("literal text");
      const result = runReader(directory, name);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBe("literal text");
    }
  });
});

test("invalid encodings, NUL and blank input fail identically through files and real pipes", async () => {
  const invalidEncoding = [
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xf0, 0x9f, 0x98]),
    Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    Buffer.from([0xff, 0xfe, 0x61, 0x00]),
    Buffer.from([0xfe, 0xff, 0x00, 0x61]),
  ];
  const nulInput = [Buffer.from("a\0b"), Buffer.from("text", "utf16le"), Buffer.from([0x00, 0x61])];
  const blankInput = ["", "\n\r\n", " \t\r\n", "\uFEFF", "\uFEFF\n", "\u2003\u00A0"];
  await withDirectory(async (directory) => {
    const path = join(directory, "input.md");
    for (const source of [...invalidEncoding, ...nulInput, ...blankInput.map((text) => Buffer.from(text))]) {
      writeFileSync(path, source);
      const failedFile = runReader(directory, path);
      const failedPipe = runReader(directory, "-", source);
      for (const result of [failedFile, failedPipe]) {
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
        expect(failure).toMatchObject({ code: "invalid_input", details: { argument: "--description-file" } });
        if (invalidEncoding.includes(source)) {
          expect(failure.message).toContain("UTF-8");
        }
        if (nulInput.includes(source)) {
          expect(failure.message).toContain("NUL");
        }
      }
      expect(readFileSync(path)).toEqual(source);
    }
  });
});

test("the raw-byte cap includes BOM, whitespace and trailing line breaks before decoding", async () => {
  const atLimit = Buffer.from("a".repeat(MAX_TEXT_BYTES - 4) + "😀");
  const oversized = [
    Buffer.concat([atLimit, Buffer.from("x")]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), atLimit]),
    Buffer.concat([atLimit, Buffer.from("\r\n")]),
    Buffer.from(" \r\n".repeat(Math.ceil(MAX_TEXT_BYTES / 3))),
    Buffer.concat([atLimit, Buffer.from([0xff])]),
  ];
  await withDirectory(async (directory) => {
    const path = join(directory, "input.md");
    writeFileSync(path, atLimit);
    expect(await resolveTextInput(undefined, path, "--description")).toBe(atLimit.toString());
    const pipe = runReader(directory, "-", atLimit);
    expect(pipe.code, pipe.stderr).toBe(0);
    expect(JSON.parse(pipe.stdout)).toBe(atLimit.toString());
    for (const bytes of oversized) {
      writeFileSync(path, bytes);
      for (const source of [path, "-"]) {
        const result = runReader(directory, source, bytes);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
        expect(failure.code).toBe("invalid_input");
        expect(failure.message).toContain(String(MAX_TEXT_BYTES));
      }
    }
  });
});

test("long runs of trailing line breaks are removed completely within the byte cap", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "input.md");
    for (const text of ["x" + "\n".repeat(MAX_TEXT_BYTES - 1), "x" + "\r\n".repeat((MAX_TEXT_BYTES - 2) / 2)]) {
      writeFileSync(path, text);
      expect(await resolveTextInput(undefined, path, "--description")).toBe("x");
      const result = runReader(directory, "-", Buffer.from(text));
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBe("x");
    }
  });
});

test("stdin decodes multi-chunk emoji only after collecting all bytes", async () => {
  const text = "😀 quote \\ 日本語\n".repeat(8_000);
  const bytes = Buffer.from(text);
  const splitInsideEmoji = 3;
  const input = Readable.from((async function* () {
    for (let offset = 0; offset < bytes.length; offset += splitInsideEmoji) {
      yield bytes.subarray(offset, offset + splitInsideEmoji);
    }
  })(), { objectMode: false });
  await withStdin(input, async () => {
    expect(await resolveTextInput(undefined, "-", "--text")).toBe(text.replace(/\n$/, ""));
  });
  await withDirectory(async (directory) => {
    const result = runReader(directory, "-", bytes);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(text.replace(/\n$/, ""));
  });
});

test("oversized stdin is refused without waiting for EOF", async () => {
  const input = new Readable({
    read(size) {
      this.push(Buffer.alloc(size, "a"));
    },
  });
  await withStdin(input, async () => {
    await expect(resolveTextInput(undefined, "-", "--text")).rejects.toMatchObject({
      code: "invalid_input",
      details: { argument: "--text-file", path: "-" },
    });
    expect(input.destroyed).toBe(true);
  });
});

test("terminal stdin fails before requesting any input", async () => {
  let wasRead = false;
  const input = Object.assign(new Readable({ read() { wasRead = true; } }), { isTTY: true });
  await withStdin(input, async () => {
    await expect(resolveTextInput(undefined, "-", "--description")).rejects.toMatchObject({
      code: "invalid_input",
      details: { argument: "--description-file", path: "-" },
    });
    expect(wasRead).toBe(false);
  });
});

test("stdin read failures and premature close never return partial text", async () => {
  const broken = new Readable({
    read() {
      this.push(Buffer.from("partial"));
      this.destroy(Object.assign(new Error("read failed"), { code: "EIO" }));
    },
  });
  await withStdin(broken, async () => {
    await expect(resolveTextInput(undefined, "-", "--text")).rejects.toMatchObject({
      code: "storage",
      details: { argument: "--text-file", path: "-", reason: "io", cause: { code: "EIO" } },
    });
  });
  const closed = new Readable({ read() { this.destroy(); } });
  await withStdin(closed, async () => {
    await expect(resolveTextInput(undefined, "-", "--text")).rejects.toMatchObject({
      code: "storage",
      details: { argument: "--text-file", path: "-", reason: "io" },
    });
  });
});

test("missing files and directories fail with source facts", async () => {
  await withDirectory(async (directory) => {
    const missing = join(directory, "missing.md");
    await expect(resolveTextInput(undefined, missing, "--text")).rejects.toMatchObject({
      code: "storage",
      details: { path: missing, argument: "--text-file", cause: { code: "ENOENT" } },
    });
    const result = runReader(directory, missing);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
    expect(failure.message).toContain("--description-file");
    expect(failure.message.split(missing)).toHaveLength(2);
    expect(failure.details?.cause?.message).toContain(missing);
    expect(failure.message).not.toContain(failure.details!.cause!.message);
    await expect(resolveTextInput(undefined, directory, "--text")).rejects.toMatchObject({
      code: "invalid_input",
      details: { path: directory, argument: "--text-file" },
    });
  });
});

test.skipIf(!isPosix)("overlong filenames and symlink loops report storage failures with OS causes", async () => {
  await withDirectory(async (directory) => {
    const filenameBeyondComponentLimit = "a".repeat(330);
    const loopingPath = join(directory, "loop");
    symlinkSync(loopingPath, loopingPath);
    for (const [path, code] of [[join(directory, filenameBeyondComponentLimit), "ENAMETOOLONG"], [loopingPath, "ELOOP"]]) {
      const result = runReader(directory, path!);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
      expect(failure).toMatchObject({
        code: "storage",
        details: { argument: "--description-file", path, reason: "io", cause: { code } },
      });
      expect(failure.details?.cause?.message).toContain(path!);
    }
  });
});

test.skipIf(!isPosix || process.getuid?.() === 0)("unreadable files retain the OS permission cause", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "unreadable.md");
    writeFileSync(path, "kept");
    chmodSync(path, 0);
    try {
      await expect(resolveTextInput(undefined, path, "--description")).rejects.toMatchObject({
        code: "storage",
        details: { path, reason: "permission_denied", cause: { code: "EACCES" } },
      });
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path, "utf8")).toBe("kept");
  });
});

test.skipIf(!isPosix)("FIFOs, devices, sockets and aliases of stdin are refused without reading", async () => {
  await withDirectory(async (directory) => {
    const fifo = join(directory, "input.fifo");
    const madeFifo = Bun.spawnSync(["mkfifo", fifo]);
    expect(madeFifo.exitCode).toBe(0);
    const socket = join(directory, "input.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    try {
      for (const path of [fifo, socket, "/dev/null", "/dev/stdin"]) {
        const result = runReader(directory, path);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        const failure = errorDocumentSchema.parse(JSON.parse(result.stderr)).error;
        expect(failure).toMatchObject({ code: "invalid_input", details: { path } });
        expect(failure.message).toContain('"-"');
      }
      const alias = join(directory, "alias.md");
      symlinkSync(fifo, alias);
      await expect(resolveTextInput(undefined, alias, "--text")).rejects.toMatchObject({ code: "invalid_input" });
      rmSync(alias);
      const regular = join(directory, "regular.md");
      writeFileSync(regular, "regular text");
      symlinkSync(regular, alias);
      expect(await resolveTextInput(undefined, alias, "--text")).toBe("regular text");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("a file disappearing or growing after stat cannot return unchecked text", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "changing.md");
    for (const change of [() => rmSync(path), () => writeFileSync(path, "a".repeat(MAX_TEXT_BYTES + 1))]) {
      writeFileSync(path, "original");
      const originalStat = fs.stat.bind(fs);
      const stat = spyOn(fs, "stat").mockImplementationOnce((async (...args: Parameters<typeof fs.stat>) => {
        const result = await originalStat(...args);
        change();
        return result;
      }) as typeof fs.stat);
      try {
        await expect(resolveTextInput(undefined, path, "--description")).rejects.toBeInstanceOf(CliError);
      } finally {
        stat.mockRestore();
      }
    }
  });
});

test("growth after the handle check is bounded and read failures close the file", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "changing.md");
    for (const failsDuringRead of [false, true]) {
      writeFileSync(path, "original");
      const file = await fs.open(path, "r");
      const originalStat = file.stat.bind(file);
      const stat = spyOn(file, "stat").mockImplementationOnce((async () => {
        const result = await originalStat();
        writeFileSync(path, "a".repeat(MAX_TEXT_BYTES + 1));
        return result;
      }) as typeof file.stat);
      const open = spyOn(fs, "open").mockResolvedValueOnce(file);
      const read = failsDuringRead
        ? spyOn(file, "read").mockRejectedValueOnce(Object.assign(new Error("read failed"), { code: "EIO" }))
        : undefined;
      try {
        await expect(resolveTextInput(undefined, path, "--description")).rejects.toMatchObject({
          code: failsDuringRead ? "storage" : "invalid_input",
          details: { argument: "--description-file", path },
        });
        await expect(file.stat()).rejects.toMatchObject({ code: "EBADF" });
      } finally {
        open.mockRestore();
        stat.mockRestore();
        read?.mockRestore();
        await file.close();
      }
    }
  });
});

test.skipIf(!isPosix)("a file replaced with a FIFO after stat does not block open", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "changing.md");
    writeFileSync(path, "original");
    const originalStat = fs.stat.bind(fs);
    const stat = spyOn(fs, "stat").mockImplementationOnce((async (...args: Parameters<typeof fs.stat>) => {
      const result = await originalStat(...args);
      rmSync(path);
      expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
      return result;
    }) as typeof fs.stat);
    try {
      await expect(resolveTextInput(undefined, path, "--description")).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      stat.mockRestore();
    }
  });
});
