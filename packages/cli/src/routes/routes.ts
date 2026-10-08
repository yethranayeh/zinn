import { projectRouter } from "./project-router";
import { taskRouter } from "./task-router";
import { labelRouter } from "./label-router";
import { backupCommand } from "./backup-router";
import { restoreCommand } from "./restore-router";
import { migrateCommand } from "./migrate-router";
import { reindexCommand } from "./reindex-router";
import { activityRouter } from "./activity-router";

// TODO: lazy load?
export const routes = {
  project: projectRouter,
  task: taskRouter,
  label: labelRouter,
  activity: activityRouter,
  backup: backupCommand,
  restore: restoreCommand,
  migrate: migrateCommand,
  reindex: reindexCommand,
};
