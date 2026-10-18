import { projectRouter } from "./project-router.js";
import { taskRouter } from "./task-router.js";
import { labelRouter } from "./label-router.js";
import { activityRouter } from "./activity-router.js";
import { backupCommand } from "./backup-router.js";
import { restoreCommand } from "./restore-router.js";
import { migrateCommand } from "./migrate-router.js";
import { reindexCommand } from "./reindex-router.js";
import { infoCommand } from "./info-router.js";
import { capabilitiesCommand } from "./capabilities-router.js";

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
  info: infoCommand,
  capabilities: capabilitiesCommand,
};
