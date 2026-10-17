import { activityRouter } from "./activity-router.js";
import { backupCommand } from "./backup-router.js";
import { infoCommand } from "./info-router.js";
import { labelRouter } from "./label-router.js";
import { migrateCommand } from "./migrate-router.js";
import { projectRouter } from "./project-router.js";
import { reindexCommand } from "./reindex-router.js";
import { restoreCommand } from "./restore-router.js";
import { taskRouter } from "./task-router.js";

// TODO: lazy load?
export const routes = {
  activity: activityRouter,
  backup: backupCommand,
  info: infoCommand,
  label: labelRouter,
  migrate: migrateCommand,
  project: projectRouter,
  reindex: reindexCommand,
  restore: restoreCommand,
  task: taskRouter,
};
