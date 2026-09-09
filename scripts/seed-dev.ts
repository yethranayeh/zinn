import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

delete process.env.ZINN_DIR;

const expectedDatabasePath = join(homedir(), ".zinn", "data", "zinn.sqlite");
const { DB_PATH } = await import("../packages/core/src/constant.ts");

if (DB_PATH !== expectedDatabasePath) {
  throw new Error(`Refusing to reset unexpected database path: ${DB_PATH}`);
}

for (const databaseFile of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  rmSync(databaseFile, { force: true });
}

const { column, project, task } = await import("../packages/core/index.ts");

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
) {
  task.create({ project_id: projectId, title, description });
}

const app = createProject({ key: "APP", name: "Zinn App" });
column.create({ projectKey: app.key, name: "Blocked" });
createTask(app.id, "Design task movement", "Move cards between project columns");
createTask(app.id, "Add column-aware task ordering", "Keep card positions local to each column");
createTask(app.id, "Render the board in the TUI", "Start with keyboard navigation");
createTask(app.id, "Document the local development workflow", "Cover seeding and local commands");
createTask(app.id, "Verify a task without a description");

const site = createProject({ key: "SITE", name: "Zinn Website" });
column.create({ projectKey: site.key, name: "Icebox" });
createTask(site.id, "Write the project overview", "Explain what makes Zinn useful");
createTask(site.id, "Capture terminal screenshots");
createTask(site.id, "Publish installation instructions", "Cover Bun and the zinn executable");

const experiments = createProject({ key: "LAB", name: "Experiments" });
createTask(experiments.id, "Try a compact task card layout");
createTask(experiments.id, "Explore activity history", "Keep the first version read-only");

console.info(`Reset and seeded the default Zinn database at ${DB_PATH}`);
console.info("Run `zinn task list` to inspect it.");
