import "./src/config";
import { addProject, db, getProjectByKey } from "./src/db";

export function createProject(key: string, name: string) {
  const project = getProjectByKey(key);

  if (project != null) {
    throw new Error(`Project with key "${key}" already exists!`);
  }

  addProject(key, name);
}
