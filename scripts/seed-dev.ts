import { rmSync } from "node:fs";
import { join } from "node:path";
import { selectDevelopmentDatabase } from "./dev-environment";

const developmentDirectory = selectDevelopmentDatabase();

const expectedDatabasePath = join(developmentDirectory, "data", "zinn.sqlite");
const { DB_PATH } = await import("../packages/core/src/constant.ts");

if (DB_PATH !== expectedDatabasePath) {
  throw new Error(`Refusing to reset unexpected database path: ${DB_PATH}`);
}

for (const databaseFile of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  rmSync(databaseFile, { force: true });
}

const { column, label, project, relation, task } = await import("../packages/core/index.ts");
type Actor = import("../packages/core/index.ts").Actor;

// Two actors so activity history shows both kinds.
const seedHuman: Actor = { name: "Dev Human", email: "dev@example.com", kind: "human" };
const seedAgent: Actor = { name: "claude-code", email: null, kind: "agent" };

function createProject(props: { key: string; name: string }) {
  project.create(props);

  const createdProject = project.getByKey(props.key);
  if (createdProject == null) {
    throw new Error(`Seeded project "${props.key}" could not be read back`);
  }

  return createdProject;
}

function createTask(
  projectId: string,
  title: string,
  description: string | null = null,
  labelNames: string[] = [],
) {
  return task.create({ project_id: projectId, title, description, labelNames }, seedHuman);
}

// Shared labels make it easy to explore classification across projects.
label.create({ name: "feature", description: "New user-facing capabilities", color: "green" });
label.create({ name: "bug", description: "Unexpected behavior to investigate", color: "red" });
label.create({ name: "docs", description: "Guides, examples, and onboarding", color: "blue" });
label.create({ name: "interface", description: "Terminal layout and interaction", color: "cyan" });
label.create({ name: "research", description: "Experiments that inform a later decision", color: "magenta" });

const app = createProject({ key: "APP", name: "Zinn App" });
column.create({ projectKey: app.key, name: "Blocked" });
createTask(app.id, "Design task movement", "Move cards between project columns", ["feature"]);
createTask(app.id, "Add column-aware task ordering", "Keep card positions local to each column", ["feature"]);
createTask(app.id, "Render the board in the TUI", [
  "Build a keyboard-first board for the existing task workflow.",
  "",
  "Acceptance criteria:",
  "- Show columns and their ordered tasks.",
  "- Open task details without losing the selected card.",
  "- Move cards using the existing core operations.",
].join("\n"), ["feature", "interface"]);
createTask(app.id, "Document the local development workflow", "Cover seeding and local commands", ["docs"]);
createTask(app.id, "Explore saved board views");
createTask(app.id, "Keep long task titles readable", "Try wrapping and truncation on a narrow terminal", ["bug", "interface"]);
createTask(app.id, "Show keyboard shortcuts", "Keep common actions discoverable from the board", ["interface"]);
createTask(app.id, "Write a first-run walkthrough", "Walk through creating a project and finishing a task", ["docs"]);
createTask(app.id, "Polish the board walkthrough", "Needs the first working board before examples can be finalized", ["docs", "interface"]);

task.move({ taskKey: "APP-1", targetColumn: "Done" }, seedAgent);
task.move({ taskKey: "APP-2", targetColumn: "Review" }, seedAgent);
task.move({ taskKey: "APP-3", targetColumn: "In Progress" }, seedAgent);
task.move({ taskKey: "APP-4", targetColumn: "Done" }, seedAgent);
task.move({ taskKey: "APP-6", targetColumn: "TODO" }, seedAgent);
task.move({ taskKey: "APP-7", targetColumn: "TODO" }, seedAgent);
task.move({ taskKey: "APP-8", targetColumn: "TODO" }, seedAgent);
task.move({ taskKey: "APP-9", targetColumn: "Blocked" }, seedAgent);
// Display order is independent of task number; leave several cards to rearrange.
task.order({ taskKey: "APP-8", direction: "before", targetTaskKey: "APP-6" }, seedAgent);

const site = createProject({ key: "SITE", name: "Zinn Website" });
column.create({ projectKey: site.key, name: "Icebox" });
createTask(site.id, "Write the project overview", "Explain what makes Zinn useful", ["docs"]);
createTask(site.id, "Capture terminal screenshots", "Wait for the board layout before capturing images", ["docs", "interface"]);
createTask(site.id, "Publish installation instructions", "Cover Bun and the zinn executable", ["docs"]);
createTask(site.id, "Explore an interactive demo", "Revisit after the first documentation release", ["research"]);
task.move({ taskKey: "SITE-1", targetColumn: "Review" }, seedAgent);
task.move({ taskKey: "SITE-3", targetColumn: "Done" }, seedAgent);
task.move({ taskKey: "SITE-4", targetColumn: "Icebox" }, seedAgent);

const experiments = createProject({ key: "LAB", name: "Experiments" });
createTask(experiments.id, "Try a compact task card layout", null, ["research", "interface"]);
createTask(experiments.id, "Explore activity history", "Keep the first version read-only", ["research"]);
createTask(experiments.id, "Prototype keyboard navigation", "Superseded by the board navigation task", ["interface"]);
task.move({ taskKey: "LAB-1", targetColumn: "In Progress" }, seedAgent);
task.move({ taskKey: "LAB-3", targetColumn: "Done" }, seedAgent);
task.archive("LAB-3", seedAgent);

// Dependencies: source depends on target. APP-3 shows both outgoing and incoming links.
relation.create({ sourceTaskKey: "APP-3", targetTaskKey: "APP-1", relation_type: "dependency" }, seedAgent);
relation.create({ sourceTaskKey: "APP-3", targetTaskKey: "APP-2", relation_type: "dependency" }, seedAgent);
relation.create({ sourceTaskKey: "SITE-2", targetTaskKey: "APP-3", relation_type: "dependency" }, seedAgent);
relation.create({ sourceTaskKey: "APP-9", targetTaskKey: "APP-3", relation_type: "dependency" }, seedAgent);

// Related links are symmetric, including across projects.
relation.create({ sourceTaskKey: "APP-3", targetTaskKey: "LAB-1", relation_type: "related" }, seedAgent);
relation.create({ sourceTaskKey: "SITE-3", targetTaskKey: "APP-4", relation_type: "related" }, seedAgent);

// Duplicate: source is a duplicate of target. Archived tasks remain visible in relations.
relation.create({ sourceTaskKey: "LAB-3", targetTaskKey: "APP-3", relation_type: "duplicate" }, seedAgent);

console.info(`Reset and seeded the development Zinn database at ${DB_PATH}`);
console.info("Run `bun run dev -- task list` to inspect it.");
console.info("Run `bun run dev -- task view APP-3` or `bun run dev -- task relation list APP-3` to inspect relations.");
console.info("Run `bun run dev -- label list` to browse shared labels, or `bun run dev -- task list LAB --all` to see archived work.");
console.info("Try `bun run dev -- task order APP-7 top` or `bun run dev -- task unarchive LAB-3`, then reseed to start over.");
