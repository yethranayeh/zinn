import type { Actor } from "../packages/core/index.ts";
import type { HourRow, ProjectStats } from "./stats-export.ts";

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { activity, column, comment, label, project, task } from "../packages/core/index.ts";
import { withTestStore } from "../packages/core/src/testing.ts";
import { summarizeBackups, summarizeProjects } from "./stats-export.ts";
import { TEST_ENVIRONMENT } from "./test-isolation.ts";

const SCRIPT_PATH = fileURLToPath(new URL("./stats-export.ts", import.meta.url));
const ALLOWED = [{ key: "APP", kind: "core" }];

const human: Actor = {
  name: "Wren Quillfeather",
  email: "wren.quillfeather@example.invalid",
  kind: "human",
  sessionId: "session-kestrel-4471",
  threadId: "thread-heron-8812",
};
const modelAgent: Actor = { name: "opencode", email: null, kind: "agent", model: "test/model-one" };
const versionedAgent: Actor = { name: "claude-code_2-1-999_agent", email: null, kind: "agent" };
const unknownAgent: Actor = { name: "lantern-runner", email: null, kind: "agent" };

/** The counts of one field summed over every hour of a project. */
function sumHours(stats: ProjectStats, field: Exclude<keyof HourRow, "hour" | "tasksCreated">) {
  const totals: Record<string, number> = {};
  for (const row of stats.hours) {
    for (const [key, count] of Object.entries(row[field] ?? {})) {
      totals[key] = (totals[key] ?? 0) + count;
    }
  }
  return totals;
}

function nonZero(counts: Record<string, number>) {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count !== 0));
}

test("projects outside the allowlist and private text leave no trace in the output", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP", name: "Orchard Ledger", description: "Plum quarry notes" }, human);
    const hidden = project.create({ key: "HUSH", name: "Velvet Vault" }, human);
    label.create({ name: "label-vermilion" }, human);
    const visible = task.create(
      {
        project_id: app.id,
        title: "Title marigold sextant",
        description: "Description cobalt lantern",
        labelNames: ["label-vermilion"],
      },
      human,
    );
    comment.create({ taskKey: visible.key, text: "Comment saffron compass" }, modelAgent);
    const hiddenTask = task.create({ project_id: hidden.id, title: "Hidden juniper beacon" }, human);
    task.move({ taskKey: hiddenTask.key, targetColumn: "Done" }, human);

    const output = summarizeProjects(ALLOWED);
    const serialized = JSON.stringify(output);
    const privateValues = [
      "Orchard Ledger",
      "Plum quarry",
      "Title marigold",
      "cobalt lantern",
      "label-vermilion",
      "saffron compass",
      "Wren Quillfeather",
      "wren.quillfeather",
      "session-kestrel",
      "thread-heron",
      visible.key,
      visible.id,
      app.id,
      "HUSH",
      "Velvet Vault",
      "juniper beacon",
      hiddenTask.id,
      hidden.id,
      ...column.getAllByProjectKey("APP").map((entry) => entry.id),
      ...column.getAllByProjectKey("HUSH").map((entry) => entry.id),
      ...activity.getAll({ projectKey: "APP" }).events.map((event) => event.id),
      ...activity.getAll({ projectKey: "HUSH" }).events.map((event) => event.id),
    ];

    expect(privateValues.filter((value) => serialized.includes(value))).toEqual([]);
    expect(output.projects.map((entry) => entry.key)).toEqual(["APP"]);
    expect(output.projects[0]!.tasks.total).toBe(1);
    expect(sumHours(output.projects[0]!, "actions")).toEqual({
      "project.create": 1,
      "task.comment_create": 1,
      "task.create": 1,
    });
  });
});

test("events are counted by action and actor kind", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, human);
    const first = task.create({ project_id: app.id, title: "First" }, human);
    task.create({ project_id: app.id, title: "Second" }, modelAgent);
    task.move({ taskKey: first.key, targetColumn: "TODO" }, modelAgent);
    comment.create({ taskKey: first.key, text: "Noted" }, human);

    const [stats] = summarizeProjects(ALLOWED).projects;

    expect(sumHours(stats!, "actions")).toEqual({
      "project.create": 1,
      "task.comment_create": 1,
      "task.create": 2,
      "task.move": 1,
    });
    expect(sumHours(stats!, "actorKinds")).toEqual({ agent: 2, human: 3 });
    expect(stats!.hours.reduce((total, row) => total + (row.tasksCreated ?? 0), 0)).toBe(2);
  });
});

test("agent names map to host families and events without a model add nothing to models", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, human);
    task.create({ project_id: app.id, title: "Known host" }, modelAgent);
    task.create({ project_id: app.id, title: "Versioned host" }, versionedAgent);
    task.create({ project_id: app.id, title: "Unknown host" }, unknownAgent);

    const [stats] = summarizeProjects(ALLOWED).projects;

    expect(sumHours(stats!, "hosts")).toEqual({ "claude-code": 1, opencode: 1, other: 1 });
    expect(sumHours(stats!, "models")).toEqual({ "test/model-one": 1 });
    expect(sumHours(stats!, "actorKinds")).toEqual({ agent: 3, human: 1 });
  });
});

test("column replay of created, moved and deleted tasks sums to the current board", () => {
  withTestStore(() => {
    const app = project.create({ key: "APP" }, human);
    const moved = task.create({ project_id: app.id, title: "Moved", columnName: "Backlog" }, human);
    task.move({ taskKey: moved.key, targetColumn: "TODO" }, human);
    task.move({ taskKey: moved.key, targetColumn: "Done" }, human);
    const deleted = task.create({ project_id: app.id, title: "Deleted", columnName: "Review" }, human);
    task.delete(deleted.key, human);
    const archived = task.create({ project_id: app.id, title: "Archived", columnName: "Backlog" }, human);
    task.archive(archived.key, human);

    const [stats] = summarizeProjects(ALLOWED).projects;

    expect(nonZero(sumHours(stats!, "columns"))).toEqual({ Backlog: 1, Done: 1 });
    expect(nonZero(stats!.tasks.byColumn)).toEqual({ Backlog: 1, Done: 1 });
    expect(stats!.tasks).toMatchObject({ total: 2, archived: 1 });
    expect(Object.keys(stats!.tasks.byColumn)).toEqual(stats!.columns);
  });
});

test("backup facts come from file names and carry no name or suffix", () => {
  const stats = summarizeBackups([
    "2026-03-02T10-00-00Z-cli-1.3.0-dev-0a1b2c3d.sqlite",
    "2026-03-01T09-00-00Z-cli-1.2.0-9f8e7d6c.sqlite",
    "2026-03-03T11-00-00Z-cli-1.2.0-5b4a3c2d.sqlite",
    "2026-02-01T08-00-00Z-cli-1.1.0.sqlite",
    "2026-03-04T12-00-00Z-tui-2.0.0-1c2d3e4f.sqlite",
    "zinn.sqlite",
    "notes.txt",
  ]);

  expect(stats).toEqual({
    count: 5,
    first: "2026-02-01T08:00:00Z",
    last: "2026-03-04T12:00:00Z",
    cliVersions: [
      { version: "1.2.0", prerelease: false, backups: 2 },
      { version: "1.3.0-dev", prerelease: true, backups: 1 },
    ],
  });
});

test("the entry point refuses a file whose name is not a backup name", () => {
  const directory = mkdtempSync(join(tmpdir(), "zinn-stats-export-"));
  try {
    const databasePath = join(directory, "zinn.sqlite");
    writeFileSync(databasePath, "");

    const result = Bun.spawnSync([process.execPath, SCRIPT_PATH, databasePath], {
      env: TEST_ENVIRONMENT,
    });

    expect(result.exitCode).not.toBe(0);
    expect(readdirSync(directory)).toEqual(["zinn.sqlite"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
