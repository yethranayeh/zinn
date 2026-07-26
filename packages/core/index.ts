// TODO: do not initialize before the first "valid" command
import "./src/config";
import { db, addProject, getProjectByKey, deleteProjectByKey } from "./src/db";

function standardizeKey(key: string) {
  // TODO: maybe force latin characters only to prevent unexpected stuff from charaters like Ğ, İ, etc.
  return key.toUpperCase();
}

// TODO: switch to object param
export function createProject(key: string, name: string) {
  const standardizedKey = standardizeKey(key);
  const project = getProjectByKey(standardizedKey);

  if (project != null) {
    throw new Error(`Project with key "${standardizedKey}" already exists!`);
  }

  addProject(standardizedKey, name);
}

export function deleteProject(key: string) {
  const standardizedKey = standardizeKey(key);
  const project = getProjectByKey(standardizedKey);

  if (project == null) {
    throw new Error(`Project with key "${standardizedKey}" does not exist!`);
  }

  deleteProjectByKey(standardizedKey);
}
