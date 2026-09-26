import type { TaskRelation, TaskWithKey } from "../types";
import type { RelationCreateInput, RelationDeleteInput } from "../schemas/relation";
import type { Actor } from "../schemas/actor";

import { getDb } from "../db";

import * as dbTask from "../db/task";
import * as dbRelation from "../db/relation";

import { validateTaskInput } from "../schemas/task";
import { relationCreateSchema, relationDeleteSchema } from "../schemas/relation";
import { actorSchema } from "../schemas/actor";

import { getTaskByKey, attachTaskKey, recordTaskActivity, describeRelation } from "./shared";

type RelationResult = TaskRelation & {
  source?: TaskWithKey;
  target?: TaskWithKey;
};

type RelationGetOptions = {
  include?: { tasks?: boolean };
};

function getRelations(taskKey: string, options?: RelationGetOptions): Array<RelationResult> {
  if (taskKey == null) {
    throw new Error("A task key is required to list relations");
  }

  const taskMatch = getTaskByKey(taskKey);
  const relations = dbRelation.getAllByTaskId(taskMatch.id);
  if (!options?.include?.tasks) {
    return relations;
  }

  return relations.map((entry) => ({
    ...entry,
    source: attachTaskKey(dbTask.getById(entry.source_task_id)!),
    target: attachTaskKey(dbTask.getById(entry.target_task_id)!),
  }));
}

function resolveRelationTaskIds(props: RelationCreateInput) {
  const sourceTask = getTaskByKey(props.sourceTaskKey);
  const targetTask = getTaskByKey(props.targetTaskKey);

  if (sourceTask.id === targetTask.id) {
    throw new Error("A task cannot have a relation to itself. Not appropriate.");
  }

  let sourceId = sourceTask.id;
  let targetId = targetTask.id;

  /**
   * To avoid headaches with relations that
   *  technically have no semantic source/target
   *  it felt reasonable to invent reliable "source" and "target"
   *  by enforcing the placements through ID comparison
   */
  const isSymmetricRelation = props.relation_type === "related";
  if (isSymmetricRelation && sourceId > targetId) {
    sourceId = targetTask.id;
    targetId = sourceTask.id;
  }

  return { source_task_id: sourceId, target_task_id: targetId, relation_type: props.relation_type };
}

export const relation = {
  /** Records the same relation_create row on both tasks. */
  create: (input: RelationCreateInput, actor: Actor) => {
    const props = validateTaskInput(relationCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const resolved = resolveRelationTaskIds(props);
      const relationMatch = dbRelation.getByTaskIdsAndType(resolved);

      if (relationMatch != null) {
        throw new Error("This relation already exists");
      }

      const createdRelation = dbRelation.create(resolved)!;
      const changes = describeRelation(createdRelation);

      for (const taskId of [createdRelation.source_task_id, createdRelation.target_task_id]) {
        recordTaskActivity(validActor, {
          taskId,
          action: "relation_create",
          changes,
          createdAt: createdRelation.created_at,
        });
      }

      return createdRelation;
    })();
  },
  /** Records the same relation_delete row on both tasks. */
  delete: (input: RelationDeleteInput, actor: Actor) => {
    const props = validateTaskInput(relationDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return getDb().transaction(() => {
      const resolved = resolveRelationTaskIds(props);
      const relationMatch = dbRelation.getByTaskIdsAndType(resolved);

      if (relationMatch == null) {
        throw new Error("This relation does not exist");
      }

      const changes = describeRelation(relationMatch);
      const now = Date.now();

      for (const taskId of [relationMatch.source_task_id, relationMatch.target_task_id]) {
        recordTaskActivity(validActor, {
          taskId,
          action: "relation_delete",
          changes,
          createdAt: now,
        });
      }

      dbRelation.deleteById(relationMatch.id);
      return relationMatch;
    })();
  },
  getAll: getRelations,
};
