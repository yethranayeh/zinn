import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { relationTypeSchema } from "@zinn-dev/core";
import { TEST_ENVIRONMENT } from "../../../scripts/test-isolation.ts";
import { errorDocumentSchema } from "../src/errors";
import { parseRoutes } from "../src/routes/router";
import { routes } from "../src/routes/routes";
import { CLI_PATH, runProcessAsync, runZinn, withIsolatedZinnDir, withoutTelemetry, withTestDb } from "../test-helpers";

const routeCommands = parseRoutes(routes).map(({ command }) => command);

test("every command rejects an unknown option before it opens the database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const command of routeCommands) {
      const result = await runZinn([...command.split(" "), "--bogus"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      // ? ZINN-108: a guessed flag is named with the usage line, without advice to put it after --.
      const [message, usage] = result.stderr.split("\n\n");
      expect(message).toContain("--bogus");
      expect(message).not.toContain("-- ");
      expect(usage).toContain(`Usage: zinn ${command}`);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 30_000);

type CommandWords = {
  // ? Words that fill every slot of the usage line, the optional ones included.
  words: string[];
  // ? How many of those words the command requires.
  required: number;
  // ? Whether a word of the usage line repeats (<task-key>...), so no word is one too many.
  repeats?: boolean;
  // ? Flags the command accepts more than once; every other flag is accepted once.
  repeatableFlags?: string[];
};

const commandWords: Record<string, CommandWords> = {
  "project create": { words: ["SHOP"], required: 1 },
  "project list": { words: [], required: 0 },
  "project view": { words: ["SHOP"], required: 1 },
  "project edit": { words: ["SHOP"], required: 1 },
  "project delete": { words: ["SHOP"], required: 1 },
  "project column create": { words: ["SHOP", "Later"], required: 2 },
  "project column list": { words: ["SHOP"], required: 1 },
  "project column edit": { words: ["SHOP", "Later"], required: 2 },
  "project column order": { words: ["SHOP", "TODO", "first"], required: 3 },
  "project column delete": { words: ["SHOP", "TODO"], required: 2 },
  "task create": { words: ["SHOP"], required: 1, repeatableFlags: ["label", "depends-on", "related"] },
  "task list": { words: ["SHOP"], required: 0, repeatableFlags: ["label"] },
  "task search": { words: ["refine", "SHOP"], required: 1, repeatableFlags: ["label"] },
  "task next": { words: ["SHOP"], required: 0 },
  "task view": { words: ["SHOP-1"], required: 1 },
  "task blame": { words: ["SHOP-1"], required: 1 },
  "task edit": { words: ["SHOP-1"], required: 1, repeatableFlags: ["add-label", "remove-label"] },
  "task move": { words: ["SHOP-1", "Done"], required: 2, repeats: true },
  "task order": { words: ["SHOP-1", "top"], required: 2 },
  "task archive": { words: ["SHOP-1"], required: 1, repeats: true },
  "task unarchive": { words: ["SHOP-1"], required: 1, repeats: true },
  "task delete": { words: ["SHOP-1"], required: 1, repeats: true },
  "task relation create": { words: ["SHOP-1", "SHOP-2"], required: 2 },
  "task relation list": { words: ["SHOP-1"], required: 1 },
  "task relation delete": { words: ["SHOP-1", "SHOP-2"], required: 2 },
  "task comment create": { words: ["SHOP-1"], required: 1 },
  "task comment list": { words: ["SHOP-1"], required: 1 },
  "task comment view": { words: ["SHOP-1#1"], required: 1 },
  "task comment edit": { words: ["SHOP-1#1"], required: 1 },
  "task comment delete": { words: ["SHOP-1#1"], required: 1 },
  "task label add": { words: ["SHOP-1", "bug"], required: 2, repeats: true },
  "task label remove": { words: ["SHOP-1", "bug"], required: 2, repeats: true },
  "label create": { words: ["bug"], required: 1 },
  "label list": { words: [], required: 0 },
  "label view": { words: ["bug"], required: 1 },
  "label edit": { words: ["bug"], required: 1 },
  "label delete": { words: ["bug"], required: 1 },
  "activity list": { words: [], required: 0, repeatableFlags: ["action", "changed"] },
  "activity view": { words: ["019abcdf"], required: 1 },
  info: { words: [], required: 0 },
  whoami: { words: [], required: 0 },
  capabilities: { words: [], required: 0 },
  backup: { words: [], required: 0 },
  restore: { words: ["backup.sqlite"], required: 1 },
  migrate: { words: [], required: 0 },
  reindex: { words: [], required: 0 },
};
const EXTRA_WORD = "extra-word";
// ? The usage lines that open each command's help.
const commandUsages = new Map(
  parseRoutes(routes).map(({ command, help }) => [command, help.split("\n\n")[0]!]),
);
// ? A word of a usage line: <name> to fill in, or {a|b} for a choice of literal words.
const USAGE_WORD_PATTERN = /<[^<>\s]+>|\{[^{}\s]+\}/g;
// ? The spellings a word stands for: itself, or each literal word of a choice.
const spellingsOf = (usageWord: string) =>
  usageWord.startsWith("{") ? usageWord.slice(1, -1).split("|") : [usageWord];

test("the table of command words has an entry for every route command and no other", () => {
  expect(Object.keys(commandWords).sort()).toEqual([...routeCommands].sort());
});

test("every command rejects an extra word, naming it with the usage line, before it opens the database", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words, repeats }] of Object.entries(commandWords)) {
      if (repeats) {
        continue;
      }

      const result = await runZinn([...command.split(" "), ...words, EXTRA_WORD], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(EXTRA_WORD);
      expect(result.stderr).toContain(`Usage: zinn ${command}`);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every command with required words rejects one word too few, naming a word its usage line writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words, required }] of Object.entries(commandWords)) {
      if (required === 0) {
        continue;
      }

      const result = await runZinn([...command.split(" "), ...words.slice(0, required - 1)], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");

      // ? The message is the paragraph before the usage lines. Every word is in the usage lines,
      // ? so a check on all of stderr would pass for any message.
      const [message, usage] = result.stderr.split("\n\n");
      expect(usage).toContain(`Usage: zinn ${command}`);
      const namedWords = message!.match(USAGE_WORD_PATTERN) ?? [];
      expect(namedWords.length).toBeGreaterThan(0);

      const usageSpellings = (usage!.match(USAGE_WORD_PATTERN) ?? []).flatMap(spellingsOf);
      for (const spelling of namedWords.flatMap(spellingsOf)) {
        expect(usageSpellings).toContain(spelling);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every flag in a usage line is rejected when given twice, unless the command repeats it", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words, repeatableFlags = [] }] of Object.entries(commandWords)) {
      // ? A flag followed by <...> or {...} takes a value. Any value works, since the repeat check runs first.
      const flags = [...commandUsages.get(command)!.matchAll(/--([a-z-]+)( [<{])?/g)].map(
        ([, name, valueMark]) => ({ name: name!, takesValue: valueMark !== undefined }),
      );
      for (const repeatable of repeatableFlags) {
        expect(flags.map(({ name }) => name)).toContain(repeatable);
      }

      for (const { name, takesValue } of flags) {
        if (repeatableFlags.includes(name)) {
          continue;
        }

        const flag = takesValue ? [`--${name}`, "x"] : [`--${name}`];
        const result = await runZinn([...command.split(" "), ...words, ...flag, ...flag], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`--${name}`);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every flag followed by <value> in a usage line refuses a separate value that begins with a dash, showing it joined with =", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words }] of Object.entries(commandWords)) {
      const valueFlags = [...commandUsages.get(command)!.matchAll(/(--[a-z-]+) </g)].map(([, flag]) => flag!);
      for (const flag of valueFlags) {
        const result = await runZinn([...command.split(" "), ...words, flag, "- item"], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`${flag}='- item'`);
        expect(result.stderr).toContain(`Usage: zinn ${command}`);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("every command refuses a word that begins with a single dash, showing the command with it after --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words }] of Object.entries(commandWords)) {
      const result = await runZinn([...command.split(" "), ...words, "-later"], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`zinn ${command} `);
      expect(result.stderr).toContain(" -- -later");
      expect(result.stderr).toContain(`Usage: zinn ${command}`);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("the command shown for a word that begins with a single dash runs as shown, keeping --json before --", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    const refused = await runZinn(["project", "column", "create", "--category", "todo", "SHOP", "-later", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");

    const { error } = JSON.parse(refused.stderr);
    expect(error.help).toContain("Usage: zinn project column create");
    const shownArgs = error.message.match(/zinn (.*)$/)[1];
    const proc = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
    });
    expect(proc.code).toBe(0);
    expect(JSON.parse(proc.stdout)).toMatchObject({ name: "-later" });
  });
});

const relationSuggestionCommands = parseRoutes(routes).filter(
  ({ command, guessedFlags }) => command.startsWith("task relation ") && guessedFlags !== undefined,
);
const expectedRelationTypes: Record<string, string> = {
  "--depends-on": "dependency",
  "--parent": "subtask",
  "--duplicate-of": "duplicate",
  "--related": "related",
};

for (const command of relationSuggestionCommands) {
  test(`${command.command} corrects borrowed relation flags with runnable commands and preserves direction`, async () => {
    await withIsolatedZinnDir(async (dir) => {
      expect((await runZinn(["project", "create", "LINK"], dir)).code).toBe(0);
      const source = await runZinn(["task", "create", "LINK", "--title", "Source", "--json"], dir);
      const target = await runZinn(["task", "create", "LINK", "--title", "Target", "--json"], dir);
      expect(source.code).toBe(0);
      expect(target.code).toBe(0);
      const sourceId = JSON.parse(source.stdout).id;
      const targetId = JSON.parse(target.stdout).id;
      const words = command.command.split(" ");
      const isCreating = command.effects.domain !== "delete";
      const flags = Object.keys(command.guessedFlags ?? {});
      expect(new Set(flags.map((flag) => expectedRelationTypes[flag]))).toEqual(new Set(relationTypeSchema.options));
      const snapshot = () => withTestDb(dir, (db) => ({
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        relations: db.query("SELECT * FROM task_relations ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));

      for (const flag of flags) {
        const type = expectedRelationTypes[flag]!;
        for (const flagArgs of [[flag, "LINK-2"], [`${flag}=LINK-2`]]) {
          for (const matchingType of [false, true]) {
            if (!isCreating) {
              expect((await runZinn(["task", "relation", "create", "LINK-1", "LINK-2", "--type", type], dir)).code).toBe(0);
            }
            const args = matchingType
              ? [...flagArgs, `--type=${type}`, "--", "LINK-1"]
              : ["LINK-1", ...flagArgs];
            const before = snapshot();
            const refused = await runZinn([...words, "--json", ...args], dir);
            expect(refused.code).toBe(1);
            expect(refused.stdout).toBe("");
            expect(snapshot()).toEqual(before);
            const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
            expect(error.details).toMatchObject({ argument: flag });
            const shownArgs = error.message.match(/zinn ([\s\S]*)$/)![1]!;
            const corrected = await runProcessAsync([
              "/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH,
            ], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir });
            expect(corrected.code).toBe(0);
            expect(corrected.stderr).toBe("");
            expect(JSON.parse(corrected.stdout)).toMatchObject({
              type, source: "LINK-1", target: "LINK-2", source_task_id: sourceId, target_task_id: targetId,
            });
            const after = snapshot();
            if (isCreating) {
              expect(after.relations).toEqual([expect.objectContaining({
                source_task_id: sourceId, target_task_id: targetId, relation_type: type,
              })]);
              expect((await runZinn(["task", "relation", "delete", "LINK-1", "LINK-2", "--type", type], dir)).code).toBe(0);
            } else {
              expect(after.relations).toEqual([]);
            }
          }
        }
      }
    });
  });

  test(`${command.command} leaves ambiguous or incomplete relation flags without a suggestion`, async () => {
    await withIsolatedZinnDir(async (dir) => {
      const words = command.command.split(" ");
      const cases = [
        ["LINK-1", "--parent", "LINK-2", "--related", "LINK-3"],
        ["LINK-1", "--parent", "LINK-2", "--parent=LINK-3"],
        ["LINK-1", "LINK-3", "--parent=LINK-2"],
        ["LINK-1", "--parent=LINK-2", "--type", "dependency"],
        ["--parent", "LINK-2"],
        ["LINK-1", "--parent"],
        ["LINK-1", "--parent=LINK-2", "--type"],
        ["LINK-1", "--parent=LINK-2", "--type=subtask", "--type=subtask"],
        ["LINK-1", "--parent=LINK-2", "--unknown"],
        ["LINK-1", "--type=dependency", "--parent=LINK-2", "--type=subtask"],
      ];
      for (const args of cases) {
        const refused = await runZinn([...words, ...args, "--json"], dir);
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe("");
        const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
        expect(error.code).toBe("invalid_input");
        expect(error.message).not.toContain("zinn task relation");
        expect(withoutTelemetry(readdirSync(dir))).toEqual([]);
      }
      const help = await runZinn([...words, "--help"], dir);
      expect(help.code).toBe(0);
      expect(help.stdout.split("\n")[0]).toContain(`--type {${relationTypeSchema.options.join("|")}}`);
    });
  });
}

for (const command of [
  ["task", "create"],
  ["task", "edit"],
  ["task", "comment", "create"],
  ["task", "comment", "edit"],
]) {
  test(`${command.join(" ")} corrects --body with a runnable command that preserves text and modifiers`, async () => {
    await withIsolatedZinnDir(async (dir) => {
      expect((await runZinn(["project", "create", "SHOP"], dir)).code).toBe(0);
      const isComment = command.includes("comment");
      const isEdit = command.at(-1) === "edit";
      const initialText = "Keep --body twice: --body";
      const body = "It's literal: $(false) `false`\n--body=keep";
      const title = "Keep the other task fields";
      const modes = [
        { args: [], expected: body },
        ...(isEdit ? [
          { args: ["--append"], expected: `${initialText}\n\n${body}` },
          { args: ["--replacing=--body", "--all"], expected: initialText.replaceAll("--body", body) },
        ] : []),
      ];
      const snapshot = () => withTestDb(dir, (db) => ({
        tasks: db.query("SELECT * FROM task ORDER BY id").all(),
        comments: db.query("SELECT * FROM comment ORDER BY id").all(),
        activity: db.query("SELECT * FROM activity ORDER BY id").all(),
      }));

      for (const mode of modes) {
        for (const bodyArgs of [["--body", body], [`--body=${body}`]]) {
          const seed = await runZinn([
            "task", "create", "SHOP", "--title", "Seed task", "--description", initialText, "--json",
          ], dir);
          expect(seed.code).toBe(0);
          const taskKey = JSON.parse(seed.stdout).key;
          let target = isEdit || isComment ? taskKey : "SHOP";
          if (isEdit && isComment) {
            const comment = await runZinn([
              "task", "comment", "create", taskKey, "--text", initialText, "--json",
            ], dir);
            expect(comment.code).toBe(0);
            target = JSON.parse(comment.stdout).key;
          }

          const before = snapshot();
          const otherFlags = isComment ? [] : ["--title", title, "--priority", "high"];
          const refused = await runZinn([
            ...command, target, ...otherFlags, ...bodyArgs, ...mode.args, "--json",
          ], dir);
          expect(refused.code).toBe(1);
          expect(refused.stdout).toBe("");
          expect(snapshot()).toEqual(before);

          const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
          expect(error.details).toMatchObject({ argument: "--body" });
          const shownArgs = error.message.match(/zinn ([\s\S]*)$/)![1]!;
          const corrected = await runProcessAsync([
            "/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH,
          ], { env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir });
          expect(corrected.code).toBe(0);
          expect(corrected.stderr).toBe("");
          const result = JSON.parse(corrected.stdout);
          const textField = isComment ? "text" : "description";
          expect(result[textField]).toBe(mode.expected);
          if (!isComment) {
            expect(result).toMatchObject({ title, priority: "high" });
          }
          const viewed = await runZinn([
            "task", ...(isComment ? ["comment"] : []), "view", result.key, "--json",
          ], dir);
          expect(viewed.code).toBe(0);
          expect(JSON.parse(viewed.stdout)[textField]).toBe(mode.expected);
        }
      }
    });
  });
}

test("a guessed --status on task create suggests --column and preserves the other creation arguments", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["label", "create", "bug"], dir);
    await runZinn(["label", "create", "urgent"], dir);
    const title = "Fix it's bug; $(false)";
    const description = "Keep --status=Done as text\nwith a second line";

    const cases = [
      { statusArgs: ["--status", "Doing"], projectAfterOptions: false },
      { statusArgs: ["--status=Doing"], projectAfterOptions: false },
      { statusArgs: ["--status", "Doing"], projectAfterOptions: true },
    ];
    for (const { statusArgs, projectAfterOptions } of cases) {
      const before = (await runZinn(["task", "list", "SHOP", "--json"], dir)).stdout;
      const activityBefore = await runZinn(["activity", "list", "--project", "SHOP", "--json"], dir);
      expect(activityBefore.code).toBe(0);
      const refused = await runZinn([
        "task", "create", ...(projectAfterOptions ? [] : ["SHOP"]), "--title", title, "--description", description,
        ...statusArgs, "--label", "bug", "--label", "urgent", "--priority", "high", "--json",
        ...(projectAfterOptions ? ["--", "SHOP"] : []),
      ], dir);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect((await runZinn(["task", "list", "SHOP", "--json"], dir)).stdout).toBe(before);
      const activityAfter = await runZinn(["activity", "list", "--project", "SHOP", "--json"], dir);
      expect(activityAfter.code).toBe(0);
      expect(activityAfter.stdout).toBe(activityBefore.stdout);

      const { error } = errorDocumentSchema.parse(JSON.parse(refused.stderr));
      expect(error.details).toMatchObject({ argument: "--status" });
      const shownArgs = error.message.match(/zinn (task create [\s\S]*)$/)![1]!;
      const created = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
        env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
      });
      expect(created.code).toBe(0);
      expect(created.stderr).toBe("");
      expect(JSON.parse(created.stdout)).toMatchObject({
        title, description, column: "Doing", priority: "high", labels: ["bug", "urgent"],
      });
    }
  });
});

test("a guessed --status or --column on task edit or task move suggests the task move command that runs as shown", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "Second"], dir);
    const readColumns = () => withTestDb(dir, (db) =>
      db.query<{ column: string }, []>(
        "SELECT project_column.name AS column FROM task JOIN project_column ON project_column.id = task.column_id ORDER BY task.id",
      ).all().map(({ column }) => column),
    );

    const cases: Array<[string[], string[]]> = [
      [["task", "edit", "SHOP-1", "--status", "Doing"], ["Doing", "Backlog"]],
      [["task", "edit", "SHOP-1", "--title", "Renamed", "--column=Done"], ["Done", "Backlog"]],
      [["task", "move", "SHOP-1", "SHOP-2", "--column", "TODO"], ["TODO", "TODO"]],
    ];
    for (const [args, columnsAfter] of cases) {
      const before = readColumns();
      const refused = await runZinn([...args, "--json"], dir);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(readColumns()).toEqual(before);

      const { error } = JSON.parse(refused.stderr);
      expect(error.help).toContain(`Usage: zinn ${args.slice(0, 2).join(" ")}`);
      const shownArgs = error.message.match(/zinn (task move .*)$/)[1];
      const proc = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
        env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
      });
      expect(proc.code).toBe(0);
      expect(() => JSON.parse(proc.stdout)).not.toThrow();
      expect(readColumns()).toEqual(columnsAfter);
    }
  });
});

test("every flag followed by <value> in a usage line fails without its value, showing the usage line", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const [command, { words }] of Object.entries(commandWords)) {
      const valueFlags = [...commandUsages.get(command)!.matchAll(/(--[a-z-]+) </g)].map(([, flag]) => flag!);
      for (const flag of valueFlags) {
        const result = await runZinn([...command.split(" "), ...words, flag], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(flag);
        expect(result.stderr).toContain(`Usage: zinn ${command}`);
      }
    }
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
}, 60_000);

test("the command shown for a value that begins with a dash runs as shown", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    const refused = await runZinn(["task", "create", "SHOP", "--title", "Fix it's bug", "--description", "- item", "--json"], dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(JSON.parse((await runZinn(["task", "list", "SHOP", "--json"], dir)).stdout)).toEqual([]);

    const { error } = JSON.parse(refused.stderr);
    expect(error.help).toContain("Usage: zinn task create");
    const shownArgs = error.message.match(/zinn (.*)$/)[1];
    const proc = await runProcessAsync(["/bin/sh", "-c", `exec bun "$0" ${shownArgs}`, CLI_PATH], {
      env: { ...TEST_ENVIRONMENT, ZINN_DIR: dir }, cwd: dir,
    });
    expect(proc.code).toBe(0);
    expect(JSON.parse(proc.stdout)).toMatchObject({ title: "Fix it's bug", description: "- item" });
  });
});

test("long parser and routing errors bound both output modes without changing error facts or writing data", async () => {
  await withIsolatedZinnDir(async (directory) => {
    const longText = "x".repeat(1300);
    const cases = [
      { args: ["task", "create", "APP", "--title", "Kept", "--description", `- ${longText}`], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", longText, "--description", "- item"], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "'".repeat(300), "--description", "- item"], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "Kept", "--description", "- 😀\n".repeat(400)], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "Kept", "--description", `- ${"e\u0301".repeat(700)}`], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "create", "APP", "--title", "Kept", "--description", `- ${"👨‍👩‍👧‍👦".repeat(200)}`], argument: "--description", facts: ["--description", "="], repair: true },
      { args: ["task", "search", `-${longText}`], facts: ["--"], repair: true },
      { args: ["task", "search", `-${longText}`, "--unknown"], facts: ["--"] },
      { args: ["task", "create", "APP", "--title", "Kept", "--body", longText], argument: "--body", facts: ["--body"], repair: true },
      { args: ["project", "list", `--${longText}`], argument: `--${longText}`, facts: ["--"] },
      { args: ["project", "list", longText], field: [], facts: ["…"] },
      { args: ["task", "order", "APP-1", longText], argument: "direction", facts: ["…"] },
      { args: [longText], argument: "command", facts: ["zinn --help"] },
      { args: ["task", longText, "--help"], argument: "command", facts: ["…"] },
    ];
    for (const { args, argument, field, facts, repair } of cases) {
      const text = await runZinn(args, directory);
      const json = await runZinn(["--json", ...args], directory);
      expect(text.code).toBe(1);
      expect(json.code).toBe(1);
      expect(text.stdout).toBe("");
      expect(json.stdout).toBe("");
      const { error } = errorDocumentSchema.parse(JSON.parse(json.stderr));
      expect(error.code).toBe("invalid_input");
      expect(error.message.length).toBeLessThanOrEqual(1024);
      expect(error.message.isWellFormed()).toBe(true);
      expect(text.stderr).toBe(`${error.message}${error.help === undefined ? "" : `\n\n${error.help}`}\n`);
      if (argument !== undefined) {
        expect(error.details?.argument).toBe(argument);
      }
      if (field !== undefined) {
        expect(error.details?.field).toEqual(field);
      }
      for (const fact of facts) {
        expect(error.message).toContain(fact);
      }
      if (repair) {
        expect(error.message).toMatch(/omitt/i);
        expect(error.message).not.toMatch(/zinn (?:task|project)/);
      }
    }
    expect(withoutTelemetry(readdirSync(directory))).toEqual([]);
  });
});

test("oversized column repair commands retain quoting guidance and leave existing data intact", async () => {
  await withIsolatedZinnDir(async (directory) => {
    await runZinn(["project", "create", "APP"], directory);
    await runZinn(["project", "column", "create", "APP", "In Progress", "--category", "in_progress"], directory);
    const before = await runZinn(["project", "view", "APP", "--json"], directory);
    const activityBefore = await runZinn(["activity", "list", "--json"], directory);
    const args = ["task", "create", "APP", "--title", "x".repeat(1300), "--column", "In", "Progress"];
    for (const flags of [[], ["--json"]]) {
      const refused = await runZinn([...args, ...flags], directory);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      const message = flags.length === 0
        ? refused.stderr.split("\n\n")[0]!
        : errorDocumentSchema.parse(JSON.parse(refused.stderr)).error.message;
      expect(message.length).toBeLessThanOrEqual(1024);
      expect(message).toMatch(/quot/i);
      expect(message).toMatch(/column/i);
      expect(message).toMatch(/omitt/i);
      expect(message).not.toContain("zinn task create");
    }
    expect(await runZinn(["project", "view", "APP", "--json"], directory)).toEqual(before);
    expect(await runZinn(["activity", "list", "--json"], directory)).toEqual(activityBefore);
    expect(JSON.parse((await runZinn(["task", "list", "APP", "--json"], directory)).stdout)).toEqual([]);
  });
});

test("project list, project view, the project column commands, task view and task order reject invalid requests without writes", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "Second"], dir);
    const read = () => withTestDb(dir, (db) => ({
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    // ? ZINN-51: an unknown option is named; an extra word is named and shown with the usage line;
    // ? a missing word shows the usage line. A -- in front or at the end adds no word, and a second -- is a word.
    type RejectedCases = {
      unknownOption: [string[], string];
      extraWords: Array<[string[], string]>;
      missingWords: Array<string[]>;
    };
    const casesByCommand: Record<string, RejectedCases> = {
      "project list": {
        unknownOption: [["--bogus"], "--bogus"],
        extraWords: [[["extra"], "extra"], [["--", "extra"], "extra"], [["extra", "--"], "extra"], [["--", "--"], "--"]],
        missingWords: [],
      },
      "project view": {
        unknownOption: [["SHOP", "--bogus"], "--bogus"],
        extraWords: [[["SHOP", "extra"], "extra"], [["--", "SHOP", "extra"], "extra"], [["SHOP", "--", "--"], "--"]],
        missingWords: [[], ["--"]],
      },
      "project column create": {
        unknownOption: [["SHOP", "Later", "--bogus"], "--bogus"],
        extraWords: [
          [["SHOP", "Needs", "Review"], "Review"],
          [["--", "SHOP", "Needs", "Review"], "Review"],
          [["SHOP", "Later", "--", "--"], "--"],
        ],
        missingWords: [[], ["SHOP"], ["--", "SHOP"], ["SHOP", "--"]],
      },
      "project column list": {
        unknownOption: [["SHOP", "--counts"], "--counts"],
        extraWords: [[["SHOP", "extra"], "extra"], [["--", "SHOP", "extra"], "extra"], [["SHOP", "--", "--"], "--"]],
        missingWords: [[], ["--"]],
      },
      "project column order": {
        unknownOption: [["SHOP", "TODO", "first", "--foo"], "--foo"],
        extraWords: [
          [["SHOP", "TODO", "first", "Done"], "Done"],
          [["SHOP", "TODO", "before", "Done", "Review"], "Review"],
          [["--", "SHOP", "TODO", "first", "Done"], "Done"],
          [["SHOP", "TODO", "first", "--", "--"], "--"],
        ],
        missingWords: [[], ["SHOP", "TODO"], ["SHOP", "TODO", "before"], ["--", "SHOP", "TODO"], ["SHOP", "TODO", "after", "--"]],
      },
      "task view": {
        unknownOption: [["SHOP-1", "--bogus"], "--bogus"],
        extraWords: [[["SHOP-1", "SHOP-2"], "SHOP-2"], [["--", "SHOP-1", "SHOP-2"], "SHOP-2"], [["SHOP-1", "--", "--"], "--"]],
        missingWords: [[], ["--"]],
      },
      "task order": {
        unknownOption: [["SHOP-1", "--foo"], "--foo"],
        extraWords: [
          [["SHOP-1", "top", "SHOP-2"], "SHOP-2"],
          [["SHOP-1", "before", "SHOP-2", "extra"], "extra"],
          [["--", "SHOP-1", "top", "SHOP-2"], "SHOP-2"],
          [["SHOP-1", "top", "--", "--"], "--"],
        ],
        missingWords: [[], ["SHOP-1"], ["SHOP-1", "before"], ["--", "SHOP-1"], ["SHOP-1", "after", "--"]],
      },
    };

    for (const [command, { unknownOption, extraWords, missingWords }] of Object.entries(casesByCommand)) {
      const usage = `Usage: zinn ${command}`;
      const rejections = [
        { args: unknownOption[0], facts: [unknownOption[1]] },
        ...extraWords.map(([args, word]) => ({ args, facts: [`"${word}"`, usage] })),
        ...missingWords.map((args) => ({ args, facts: [usage] })),
      ];
      for (const { args, facts } of rejections) {
        const result = await runZinn([...command.split(" "), ...args], dir);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        for (const fact of facts) {
          expect(result.stderr).toContain(fact);
        }
        expect(read()).toEqual(before);
      }
    }

    // ? An unknown direction shows both usage lines, so the valid directions are listed.
    for (const args of [["project", "column", "order", "SHOP", "TODO", "sideways"], ["task", "order", "SHOP-1", "sideways"]]) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`"sideways"`);
      expect(result.stderr).toContain("{before|after}");
      expect(read()).toEqual(before);
    }
  });
}, 30_000);

test("a -- in front of the words or at the end leaves a valid command working", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "SHOP"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "First"], dir);
    await runZinn(["task", "create", "SHOP", "--title", "Second"], dir);

    const sameAsWithout: Array<[string[], string[]]> = [
      [["task", "view", "--", "SHOP-1"], ["task", "view", "SHOP-1"]],
      [["project", "view", "SHOP", "--"], ["project", "view", "SHOP"]],
      [["project", "column", "list", "--", "SHOP"], ["project", "column", "list", "SHOP"]],
    ];
    for (const [withSeparator, withoutSeparator] of sameAsWithout) {
      const result = await runZinn(withSeparator, dir);
      expect(result.code).toBe(0);
      expect(result).toEqual(await runZinn(withoutSeparator, dir));
    }

    expect((await runZinn(["task", "order", "SHOP-2", "top", "--"], dir)).code).toBe(0);
    expect((await runZinn(["task", "list", "SHOP"], dir)).stdout).toMatch(/SHOP-2[^\n]*\nSHOP-1/);
  });
});

test("delete commands reject invalid keys and repeated --yes without deleting anything", async () => {
  await withIsolatedZinnDir(async (dir) => {
    await runZinn(["project", "create", "A"], dir);
    await runZinn(["project", "create", "B"], dir);
    await runZinn(["task", "create", "A", "--title", "First"], dir);
    await runZinn(["task", "create", "A", "--title", "Second"], dir);
    await runZinn(["task", "comment", "create", "A-1", "--text", "Note"], dir);
    await runZinn(["label", "create", "bug"], dir);
    const read = () => withTestDb(dir, (db) => ({
      projects: db.query("SELECT * FROM project ORDER BY id").all(),
      columns: db.query("SELECT * FROM project_column ORDER BY id").all(),
      tasks: db.query("SELECT * FROM task ORDER BY id").all(),
      comments: db.query("SELECT * FROM comment ORDER BY id").all(),
      labels: db.query("SELECT * FROM label ORDER BY id").all(),
      activity: db.query("SELECT * FROM activity ORDER BY id").all(),
    }));
    const before = read();
    // ? Each case lists the facts its error carries.
    const cases: Array<[string[], ...string[]]> = [
      [["project", "delete", "A", "B", "--yes"], `"B"`, "Usage: zinn project delete"],
      // After --, a flag is a task-key operand and fails key validation.
      [["task", "delete", "--", "A-1", "--yes"], `"--yes"`],
      [["task", "delete", "A-1", "--yes", "--", "--"], `"--"`],
      [["project", "delete", "A", "--yes", "--yes"], "--yes"],
      [["task", "delete", "A-1", "--yes", "--yes"], "--yes"],
      [["task", "comment", "delete", "A-1#1", "--yes", "--yes"], "--yes"],
      [["label", "delete", "bug", "--yes", "--yes"], "--yes"],
    ];
    for (const [args, ...facts] of cases) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
      expect(read()).toEqual(before);
    }
  });
});

test("--json or --allow-legacy-read given twice runs nothing, while a second help flag still shows help", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const flag of ["--json", "--allow-legacy-read"]) {
      const result = await runZinn(["project", "create", "APP", flag, flag], dir);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(flag);
    }
    expect(existsSync(join(dir, "data"))).toBe(false);

    const help = await runZinn(["task", "view", "A-1", "-h", "--help"], dir);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: zinn task view");
  });
});

test("with --json, an extra word is one JSON error on stderr whose help is the usage line", async () => {
  await withIsolatedZinnDir(async (dir) => {
    const result = await runZinn(["task", "view", "A-1", "A-2", "--json"], dir);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = JSON.parse(result.stderr);
    expect(error.message).toContain("A-2");
    expect(error.help).toContain("Usage: zinn task view");
    expect(existsSync(join(dir, "data"))).toBe(false);
  });
});

test("shared option checks reject repeated scalar flags and retain positional validation", async () => {
  await withIsolatedZinnDir(async (dir) => {
    for (const args of [
      ["label", "create", "bug", "--color", "red", "--color", "blue"],
      ["label", "create", "bug", "--description", "a", "--description", "b"],
      ["label", "edit", "bug", "--name", "a", "--name", "b"],
      ["label", "edit", "bug", "--color", "red", "--color", "blue"],
      ["label", "edit", "bug", "--description", "a", "--description", "b"],
      ["project", "create", "APP", "--name", "a", "--name", "b"],
      ["project", "edit", "APP", "--name", "a", "--name", "b"],
      ["task", "edit", "APP-1", "--title", "a", "--title", "b"],
      ["task", "relation", "create", "APP-1", "APP-2", "--type", "related", "--type", "duplicate"],
    ]) {
      const result = await runZinn(args, dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(args[args.length - 2]!);
    }
    // ? Each case lists the facts its error carries.
    const labelWordCases: Array<[string[], ...string[]]> = [
      [["label", "create"], "Usage: zinn label create"],
      [["label", "create", "one", "two"], `"two"`, "Usage: zinn label create"],
      [["label", "edit"], "Usage: zinn label edit"],
      [["label", "edit", "one", "two", "--color", "red"], `"two"`, "Usage: zinn label edit"],
    ];
    for (const [args, ...facts] of labelWordCases) {
      const result = await runZinn(args, dir);
      for (const fact of facts) {
        expect(result.stderr).toContain(fact);
      }
    }
    const extraLabel = await runZinn(["label", "delete", "one", "two"], dir);
    expect(extraLabel.stderr).toContain(`"two"`);
    expect(extraLabel.stderr).toContain("Usage: zinn label delete");
  });
});

test("task and comment key numbers are capped at 15 digits", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "CAP", "--name", "Cap"], testDir);
    await runZinn(["task", "create", "CAP", "--title", "Only task"], testDir);

    const tooManyDigits = "9".repeat(20);
    const fifteenDigits = "9".repeat(15);

    // 16+ digits: rejected as a malformed key, never rounded and looked up.
    const invalidTask = await runZinn(["--json", "task", "view", `CAP-${tooManyDigits}`], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(invalidTask.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining(`CAP-${tooManyDigits}`), details: { field: ["taskKey"] } });

    const invalidComment = await runZinn(["--json", "task", "comment", "edit", `CAP-1#${tooManyDigits}`, "--text", "x"], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(invalidComment.stderr)).error).toMatchObject({ code: "invalid_input", message: expect.stringContaining(`CAP-1#${tooManyDigits}`), details: { field: ["commentKey"] } });

    // Exactly 15 digits: still a well-formed key (an exact JS integer), just not found.
    const missingTask = await runZinn(["--json", "task", "view", `CAP-${fifteenDigits}`], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(missingTask.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "task", key: `CAP-${fifteenDigits}` } });

    const missingComment = await runZinn(["--json", "task", "comment", "edit", `CAP-1#${fifteenDigits}`, "--text", "x"], testDir);
    expect(errorDocumentSchema.parse(JSON.parse(missingComment.stderr)).error).toMatchObject({ code: "not_found", details: { entity: "comment", key: `CAP-1#${fifteenDigits}` } });
  });
});

// ? Empty strings pass the routers' `== null` guards; core's validation rejects them.
test("empty-string arguments are rejected", async () => {
  await withIsolatedZinnDir(async (testDir) => {
    await runZinn(["project", "create", "EMPTY", "--name", "Empty"], testDir);

    const blankTitle = await runZinn(["--json", "task", "create", "EMPTY", "--title", ""], testDir);
    expect(blankTitle.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(blankTitle.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["title"] } });

    const blankProject = await runZinn(["--json", "project", "create", "", "--name", ""], testDir);
    expect(blankProject.code).toBe(1);
    expect(errorDocumentSchema.parse(JSON.parse(blankProject.stderr)).error).toMatchObject({ code: "invalid_input", details: { field: ["key"] } });
  });
});
