import type { LabelCreateInput, LabelDeleteInput, LabelEditInput } from "../schemas/label";
import type { Actor } from "../schemas/actor";

import { getDb } from "../db";
import { labelCreateSchema, labelDeleteSchema, labelEditSchema } from "../schemas/label";

import * as dbTask from "../db/task";
import * as dbTaskLabel from "../db/task-label";
import * as dbLabel from "../db/label";

import { validateTaskInput } from "../schemas/task";
import { actorSchema } from "../schemas/actor";

import { findByName, resolveLabels, recordTaskActivity } from "./shared";

function findLabelByName(name: string) {
  return findByName(dbLabel.getAll(), name);
}

export const label = {
  create: (input: LabelCreateInput) => {
    const props = validateTaskInput(labelCreateSchema, input);

    if (findLabelByName(props.name) != null) {
      throw new Error(`A label with name "${props.name}" already exists`);
    }

    return dbLabel.create({
      name: props.name,
      description: props.description ?? "",
      color: props.color ?? "white",
    })!;
  },
  /** Editing a global definition preserves attachments and does not edit attached tasks. */
  edit: (input: LabelEditInput) => {
    const props = validateTaskInput(labelEditSchema, input);

    return getDb().transaction(() => {
      const match = resolveLabels([props.labelName])[0]!;
      const name = props.name ?? match.name;
      const description = props.description ?? match.description;
      const color = props.color ?? match.color;

      const isUnchanged =
        name === match.name && description === match.description && color === match.color;
      if (isUnchanged) {
        return match;
      }

      const existingLabel = findLabelByName(name);
      if (existingLabel != null && existingLabel.id !== match.id) {
        throw new Error(`A label with name "${name}" already exists`);
      }

      return dbLabel.update({ id: match.id, name, description, color })!;
    })();
  },
  getAll: dbLabel.getAll,
  getByName: (name: string) => {
    const props = validateTaskInput(labelDeleteSchema, { name });
    return findLabelByName(props.name);
  },
  /** Deleting a definition detaches it from tasks, so each affected task gets an edit row. */
  delete: (input: LabelDeleteInput, actor: Actor) => {
    const props = validateTaskInput(labelDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const match = resolveLabels([props.name])[0]!;
      const now = Date.now();

      for (const taskId of dbTaskLabel.getTaskIdsByLabelId(match.id)) {
        recordTaskActivity(validActor, {
          taskId,
          action: "edit",
          changes: { labels: { added: [], removed: [match.name] } },
          createdAt: now,
        });
      }

      dbTask.updateLabelTasksTimestamp(match.id, now);
      dbLabel.deleteById(match.id);
      return match;
    })();
  },
};
