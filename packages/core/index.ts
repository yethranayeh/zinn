import "./src/config";
import { addProject, db, getProjectByKey } from "./src/db";

export function createProject(key: string, name: string) {
  // TODO: maybe force latin characters only to prevent unexpected stuff from charaters like Ğ, İ, etc.
  const standardizedKey = key.toUpperCase();
  const project = getProjectByKey(standardizedKey);

  if (project != null) {
    throw new Error(`Project with key "${standardizedKey}" already exists!`);
  }

  addProject(standardizedKey, name);
}
