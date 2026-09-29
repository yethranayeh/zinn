import { projectRouter } from "./project-router";
import { taskRouter } from "./task-router";
import { labelRouter } from "./label-router";
import { backupCommand } from "./backup-router";

// TODO: lazy load?
export const routes = {
  project: projectRouter,
  task: taskRouter,
  label: labelRouter,
  backup: backupCommand,
};
