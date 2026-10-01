import type { LabelCreateInput, LabelDeleteInput, LabelEditInput } from "../schemas/label";
import type { Actor } from "../schemas/actor";

import { getDb } from "../db";
import { labelCreateSchema, labelDeleteSchema, labelEditSchema } from "../schemas/label";

import * as dbTask from "../db/task";
import * as dbTaskLabel from "../db/task-label";
import * as dbLabel from "../db/label";

import { validateTaskInput } from "../schemas/task";
import { actorSchema } from "../schemas/actor";

import { findByName, resolveLabels, recordActivity, recordTaskActivity } from "./shared";

function findLabelByName(name: string) {
  return findByName(dbLabel.getAll(), name);
}

export const label = {
  create: (input: LabelCreateInput, actor: Actor) => {
    const props = validateTaskInput(labelCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      if (findLabelByName(props.name) != null) {
        throw new Error(`A label with name "${props.name}" already exists`);
      }

      const createdLabel = dbLabel.create({
        name: props.name,
        description: props.description,
        color: props.color ?? "white",
      })!;

      recordActivity(validActor, {
        entityType: "label",
        entityId: createdLabel.id,
        action: "create",
        changes: {
          name: createdLabel.name,
          description: createdLabel.description,
          color: createdLabel.color,
        },
        createdAt: Date.now(),
      });

      return createdLabel;
    })();
  },
  /** Editing a global definition preserves attachments and does not edit attached tasks. */
  edit: (input: LabelEditInput, actor: Actor) => {
    const props = validateTaskInput(labelEditSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const match = resolveLabels([props.labelName])[0]!;
      const name = props.name ?? match.name;
      const description =
        props.description === undefined ? match.description : props.description;
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

      const changes: Record<string, unknown> = {};
      if (name !== match.name) {
        changes.name = [match.name, name];
      }
      if (description !== match.description) {
        changes.description = [match.description, description];
      }
      if (color !== match.color) {
        changes.color = [match.color, color];
      }

      recordActivity(validActor, {
        entityType: "label",
        entityId: match.id,
        action: "edit",
        changes,
        createdAt: Date.now(),
      });

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

      recordActivity(validActor, {
        entityType: "label",
        entityId: match.id,
        action: "delete",
        changes: { name: match.name, description: match.description, color: match.color },
        createdAt: now,
      });

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
