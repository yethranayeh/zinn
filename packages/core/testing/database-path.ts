import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { resolveBackupDirectory, resolveDatabasePath } from "../src/database-path.ts";
import { CoreError } from "../src/errors.ts";

type DefineTest = (name: string, check: () => void) => unknown;

const SEARCHABLE_DIRECTORY_MODE = 0o700;
const UNSEARCHABLE_DIRECTORY_MODE = 0o600;

function withDirectory(check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "zinn-database-path-"));

  try {
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertResolutionError(path: string, code: string) {
  assert.throws(
    () => resolveDatabasePath(path),
    (error: unknown) => {
      assert.ok(error instanceof CoreError);
      assert.equal(error.kind, "storage");
      assert.deepEqual(error.facts, { entity: "database", databasePath: path });
      assert.ok(error.cause instanceof Error);
      assert.equal((error.cause as NodeJS.ErrnoException).code, code);
      return true;
    },
  );
}

function assertBackupResolutionError(path: string, code: string) {
  assert.throws(
    () => resolveBackupDirectory(path),
    (error: unknown) => {
      assert.ok(error instanceof CoreError);
      assert.equal(error.kind, "storage");
      assert.deepEqual(error.facts, { entity: "backup", backupDirectory: path });
      assert.equal(error.message, `Cannot resolve the backup folder ${path}`);
      assert.ok(error.cause instanceof Error);
      assert.equal((error.cause as NodeJS.ErrnoException).code, code);
      return true;
    },
  );
}

export function defineDatabasePathChecks(test: DefineTest) {
  test("database paths resolve existing files without changing their contents", () => {
    withDirectory((directory) => {
      const path = join(directory, "zinn.sqlite");
      writeFileSync(path, "database contents");

      assert.equal(resolveDatabasePath(path), realpathSync(path));
      assert.equal(readFileSync(path, "utf8"), "database contents");
      assert.deepEqual(readdirSync(directory), ["zinn.sqlite"]);
    });
  });

  test("database paths resolve relative input against the working directory", () => {
    withDirectory((directory) => {
      const path = join(directory, "zinn.sqlite");
      writeFileSync(path, "database contents");

      assert.equal(resolveDatabasePath(relative(process.cwd(), path)), realpathSync(path));
      assert.equal(
        resolveDatabasePath(relative(process.cwd(), join(directory, "data", "zinn.sqlite"))),
        join(realpathSync(directory), "data", "zinn.sqlite"),
      );
      assert.equal(existsSync(join(directory, "data")), false);
    });
  });

  test("database paths follow directory and file links to the same existing target", () => {
    withDirectory((directory) => {
      const store = join(directory, "store");
      mkdirSync(store);
      const path = join(store, "zinn.sqlite");
      writeFileSync(path, "database contents");
      const directoryLink = join(directory, "alias");
      const fileLink = join(directory, "database-link");
      symlinkSync("store", directoryLink, "dir");
      symlinkSync(join("store", "zinn.sqlite"), fileLink, "file");

      const expected = realpathSync(path);
      assert.equal(resolveDatabasePath(path), expected);
      assert.equal(resolveDatabasePath(join(directoryLink, "zinn.sqlite")), expected);
      assert.equal(resolveDatabasePath(fileLink), expected);
      assert.equal(readFileSync(path, "utf8"), "database contents");
      assert.equal(lstatSync(fileLink).isSymbolicLink(), true);
    });
  });

  test("missing database paths resolve linked ancestors without creating the missing suffix", () => {
    withDirectory((directory) => {
      const store = join(directory, "store");
      mkdirSync(store);
      const link = join(directory, "alias");
      symlinkSync("store", link, "dir");
      const suffix = ["nested", "data", "zinn.sqlite"];

      assert.equal(
        resolveDatabasePath(join(link, ...suffix)),
        join(realpathSync(store), ...suffix),
      );
      assert.equal(
        resolveDatabasePath(join(store, ...suffix)),
        join(realpathSync(store), ...suffix),
      );
      assert.deepEqual(readdirSync(store), []);
      assert.deepEqual(readdirSync(directory).sort(), ["alias", "store"]);
    });
  });

  test("missing database files resolve from an existing data directory", () => {
    withDirectory((directory) => {
      assert.equal(
        resolveDatabasePath(join(directory, "zinn.sqlite")),
        join(realpathSync(directory), "zinn.sqlite"),
      );
      assert.deepEqual(readdirSync(directory), []);
    });
  });

  test("database path resolution refuses dangling links at the file or an ancestor", () => {
    withDirectory((directory) => {
      const link = join(directory, "dangling");
      symlinkSync("missing", link, "file");

      assertResolutionError(link, "ENOENT");
      assertResolutionError(join(link, "data", "zinn.sqlite"), "ENOENT");
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.deepEqual(readdirSync(directory), ["dangling"]);
    });
  });

  test("database path resolution refuses symbolic link cycles", () => {
    withDirectory((directory) => {
      const first = join(directory, "first");
      const second = join(directory, "second");
      symlinkSync("second", first, "file");
      symlinkSync("first", second, "file");

      assertResolutionError(first, "ELOOP");
      assertResolutionError(join(first, "zinn.sqlite"), "ELOOP");
      assert.deepEqual(readdirSync(directory).sort(), ["first", "second"]);
    });
  });

  test("database path resolution refuses a regular file used as a directory", () => {
    withDirectory((directory) => {
      const path = join(directory, "file");
      writeFileSync(path, "kept");

      assertResolutionError(join(path, "data", "zinn.sqlite"), "ENOTDIR");
      assert.equal(readFileSync(path, "utf8"), "kept");
      assert.deepEqual(readdirSync(directory), ["file"]);
    });
  });

  test("backup folders resolve links and missing folders without creating anything", () => {
    withDirectory((directory) => {
      const store = join(directory, "store");
      mkdirSync(store);
      const link = join(directory, "alias");
      symlinkSync("store", link, "dir");
      const suffix = ["nested", "backups"];

      assert.equal(
        resolveBackupDirectory(join(link, ...suffix)),
        join(realpathSync(store), ...suffix),
      );
      assert.equal(
        resolveBackupDirectory(join(store, ...suffix)),
        join(realpathSync(store), ...suffix),
      );
      assert.deepEqual(readdirSync(store), []);
      assert.deepEqual(readdirSync(directory).sort(), ["alias", "store"]);
    });
  });

  test("backup folder resolution refuses a dangling link and names the folder", () => {
    withDirectory((directory) => {
      const link = join(directory, "dangling");
      symlinkSync("missing", link, "file");

      assertBackupResolutionError(link, "ENOENT");
      assertBackupResolutionError(join(link, "nested"), "ENOENT");
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.deepEqual(readdirSync(directory), ["dangling"]);
    });
  });

  const enforcesDirectoryPermissions = process.platform !== "win32" && process.getuid?.() !== 0;
  if (enforcesDirectoryPermissions) {
    test("database path resolution retains permission failures instead of treating them as missing", () => {
      withDirectory((directory) => {
        const blocked = join(directory, "blocked");
        mkdirSync(blocked);
        chmodSync(blocked, UNSEARCHABLE_DIRECTORY_MODE);

        try {
          assertResolutionError(join(blocked, "data", "zinn.sqlite"), "EACCES");
        } finally {
          chmodSync(blocked, SEARCHABLE_DIRECTORY_MODE);
        }
        assert.deepEqual(readdirSync(blocked), []);
      });
    });
  }
}
