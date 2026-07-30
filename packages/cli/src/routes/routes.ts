import { projectRouter } from "./project-router";
import { taskRouter } from "./task-router";

// TODO: lazy load?
export const routes = {
  project: projectRouter,
  task: taskRouter,
};
