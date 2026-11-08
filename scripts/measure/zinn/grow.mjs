// Builds one fixture database with a published @zinn-dev/core.
// usage: ZINN_DIR=<fixture-dir> node grow.mjs <fixture-dir> <tasks> <comments 0|1> <core index.js> <version work dir>
// Fixture: project BNCH with default columns, 40-character titles, 200-character descriptions,
// and one 200-character comment per task. Text comes from words.txt with a fixed seed, so the
// same task count always produces the same content.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [dirArg, taskCountArg, withCommentsArg, coreIndexArg, versionWorkDirectoryArg] =
  process.argv.slice(2);
const directory = realpathSync(dirArg);
const versionWorkDirectory = realpathSync(versionWorkDirectoryArg);
if (process.env.ZINN_DIR !== directory) {
  throw new Error(`ZINN_DIR must equal the fixture directory ${directory}`);
}
if (!directory.startsWith(versionWorkDirectory + sep)) {
  throw new Error(`Fixture directory ${directory} is outside ${versionWorkDirectory}`);
}

const taskCount = Number(taskCountArg);
const withComments = withCommentsArg === "1";
const WORDS = readFileSync(`${HERE}/words.txt`, "utf8").split("\n").filter(Boolean);
const BY_LENGTH = new Map();
for (const word of WORDS) {
  if (!BY_LENGTH.has(word.length)) {
    BY_LENGTH.set(word.length, []);
  }
  BY_LENGTH.get(word.length).push(word);
}
const SEED = 20261101;
const TITLE_LENGTH = 40;
const DESCRIPTION_LENGTH = 200;
const COMMENT_LENGTH = 200;
const MAX_FIT_ATTEMPTS = 1000;
// words.txt has no word longer than this, so only these remainders can finish the text exactly.
const MAX_FINAL_WORD_LENGTH = 9;
// Stop a word early enough to leave a final word of at least this length.
const MIN_TRAILING_CHARS = 2;

// mulberry32
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Text of exactly `length` characters: random words joined by spaces, with the last
// word chosen to fill the remaining length.
function text(length, seed) {
  const random = rng(seed);
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt++) {
    let built = "";
    while (true) {
      const remaining = length - built.length - (built ? 1 : 0);
      const separator = built ? " " : "";
      if (remaining <= MAX_FINAL_WORD_LENGTH && BY_LENGTH.has(remaining)) {
        const candidates = BY_LENGTH.get(remaining);
        const finished =
          built + separator + candidates[Math.floor(random() * candidates.length)];
        if (finished.length === length) {
          return finished;
        }
      }
      const word = WORDS[Math.floor(random() * WORDS.length)];
      if (built.length + separator.length + word.length > length - MIN_TRAILING_CHARS) {
        break;
      }
      built += separator + word;
    }
  }
  throw new Error("no fit");
}

export { text };

const core = await import(pathToFileURL(coreIndexArg).href);
const { configureDatabase, project, task, comment } = core;
configureDatabase({
  client: "bench",
  version: "0.0.0",
  executable: fileURLToPath(import.meta.url),
  release: "source",
  allowsLegacyRead: false,
});
const actor = { name: "Alper Halil", email: "contact@aktasalper.com", kind: "human", source: "git-config" };
const database = `${directory}/data/zinn.sqlite`;
const createdProject = project.create({ key: "BNCH", name: "BNCH" }, actor);
for (let index = 1; index <= taskCount; index++) {
  task.create(
    {
      project_id: createdProject.id,
      title: text(TITLE_LENGTH, SEED + index * 3),
      description: text(DESCRIPTION_LENGTH, SEED + index * 3 + 1),
    },
    actor,
  );
  if (withComments) {
    comment.create(
      { taskKey: `BNCH-${index}`, text: text(COMMENT_LENGTH, SEED + index * 3 + 2) },
      actor,
    );
  }
}
console.log(
  `${taskCount} tasks, comments=${withComments}: db=${statSync(database).size} wal=${
    existsSync(database + "-wal") ? statSync(database + "-wal").size : "none"
  } (live process)`,
);
