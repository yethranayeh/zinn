import type { TaskRelation, TaskWithKey } from "../types.js";
import type { RelationCreateInput, RelationDeleteInput } from "../schemas/relation.js";
import type { Actor } from "../schemas/actor.js";

import { CoreError } from "../errors.js";
import { writeTransaction } from "../db.js";

import * as dbTask from "../db/task.js";
import * as dbRelation from "../db/relation.js";

import { validateTaskInput } from "../schemas/task.js";
import { relationCreateSchema, relationDeleteSchema } from "../schemas/relation.js";
import { actorSchema } from "../schemas/actor.js";

import { getTaskByKey, attachTaskKey, recordTaskActivity, describeRelation } from "./shared.js";

type RelationResult = TaskRelation & {
  source?: TaskWithKey;
  target?: TaskWithKey;
};

type RelationGetOptions = {
  include?: { tasks?: boolean };
};

function getRelations(taskKey: string, options?: RelationGetOptions): Array<RelationResult> {
  if (taskKey == null) {
    throw new CoreError("A task key is required to list relations", "input", {
      field: ["taskKey"],
    });
  }

  const taskMatch = getTaskByKey(taskKey);
  const relations = dbRelation.getAllByTaskId(taskMatch.id);
  if (!options?.include?.tasks) {
    return relations;
  }

  return relations.map(includeRelationTasks);
}

function includeRelationTasks(entry: TaskRelation) {
  return {
    ...entry,
    source: attachTaskKey(dbTask.getById(entry.source_task_id)!),
    target: attachTaskKey(dbTask.getById(entry.target_task_id)!),
  };
}

function resolveRelationTaskIds(props: RelationDeleteInput) {
  const sourceTask = getTaskByKey(props.sourceTaskKey);
  const targetTask = getTaskByKey(props.targetTaskKey);

  if (sourceTask.id === targetTask.id) {
    throw new CoreError("A task cannot have a relation to itself. Not appropriate.", "input", {
      entity: "relation",
      field: ["targetTaskKey"],
    });
  }

  let sourceId = sourceTask.id;
  let targetId = targetTask.id;

  // Symmetric relations use a canonical task-ID order.
  const isSymmetricRelation = props.relation_type === "related";
  if (isSymmetricRelation && sourceId > targetId) {
    sourceId = targetTask.id;
    targetId = sourceTask.id;
  }

  return { source_task_id: sourceId, target_task_id: targetId, relation_type: props.relation_type };
}

type ResolvedRelation = ReturnType<typeof resolveRelationTaskIds>;

function getConflictingRelations(resolved: ResolvedRelation) {
  return dbRelation.getAllByTaskId(resolved.source_task_id).filter((entry) => {
    const samePair =
      entry.source_task_id === resolved.target_task_id ||
      entry.target_task_id === resolved.target_task_id;
    const existingParent =
      resolved.relation_type === "subtask" &&
      entry.relation_type === "subtask" &&
      entry.source_task_id === resolved.source_task_id;
    return samePair || existingParent;
  });
}

function validateRelationCreation(resolved: ResolvedRelation, conflicts: Array<TaskRelation>) {
  const exactMatch = conflicts.some(
    (entry) =>
      entry.source_task_id === resolved.source_task_id &&
      entry.target_task_id === resolved.target_task_id &&
      entry.relation_type === resolved.relation_type,
  );
  if (exactMatch) {
    throw new CoreError("This relation already exists", "conflict", {
      entity: "relation",
      reason: "already_exists",
    });
  }

  if (resolved.relation_type === "subtask") {
    const ancestorIds = dbRelation.getAncestorIds(
      resolved.target_task_id,
      conflicts.map((entry) => entry.id),
    );
    if (ancestorIds.includes(resolved.source_task_id)) {
      throw new CoreError("A subtask relation cannot create a cycle", "conflict", {
        entity: "relation",
        reason: "cycle",
      });
    }
  }
}

function recordRelationActivity(
  entry: TaskRelation,
  actor: Actor,
  action: "relation_create" | "relation_delete",
  createdAt: number,
) {
  const changes = describeRelation(entry);
  for (const taskId of [entry.source_task_id, entry.target_task_id]) {
    recordTaskActivity(actor, { taskId, action, changes, createdAt });
  }
}

export const relation = {
  /** Returns the validated creation's conflicting links with both connected tasks. */
  getConflicts: (input: RelationDeleteInput) => {
    const props = validateTaskInput(relationDeleteSchema, input);
    const resolved = resolveRelationTaskIds(props);
    const conflicts = getConflictingRelations(resolved);

    validateRelationCreation(resolved, conflicts);

    return conflicts.map(includeRelationTasks);
  },
  /** Creates or explicitly replaces relations and records each change on both endpoints. */
  create: (input: RelationCreateInput, actor: Actor) => {
    const props = validateTaskInput(relationCreateSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const resolved = resolveRelationTaskIds(props);
      const conflicts = getConflictingRelations(resolved);

      if (Array.isArray(props.replace)) {
        const expectedIds = new Set(props.replace);
        const conflictsChanged =
          expectedIds.size !== conflicts.length ||
          conflicts.some((entry) => !expectedIds.has(entry.id));

        if (conflictsChanged) {
          throw new CoreError(
            "The conflicting relations changed. Run the command again to review them.",
            "conflict",
            {
              entity: "relation",
              reason: "relation_changed",
            },
          );
        }
      }

      validateRelationCreation(resolved, conflicts);

      if (conflicts.length > 0 && !props.replace) {
        const hasParent = conflicts.some(
          (entry) =>
            resolved.relation_type === "subtask" &&
            entry.relation_type === "subtask" &&
            entry.source_task_id === resolved.source_task_id,
        );

        throw new CoreError(
          "Existing relations require explicit replacement authorization",
          "conflict",
          {
            entity: hasParent ? "task" : "relation",
            key: hasParent ? props.sourceTaskKey : undefined,
            reason: hasParent ? "parent_exists" : "already_exists",
          },
        );
      }

      const now = Date.now();
      for (const entry of conflicts) {
        recordRelationActivity(entry, validActor, "relation_delete", now);
        dbRelation.deleteById(entry.id);
      }
      const createdRelation = dbRelation.create(resolved, now)!;
      recordRelationActivity(createdRelation, validActor, "relation_create", now);
      return createdRelation;
    });
  },
  /** Records the same relation_delete row on both tasks. */
  delete: (input: RelationDeleteInput, actor: Actor) => {
    const props = validateTaskInput(relationDeleteSchema, input);
    const validActor = validateTaskInput(actorSchema, actor);

    return writeTransaction(() => {
      const resolved = resolveRelationTaskIds(props);
      const relationMatch = dbRelation.getByTaskIdsAndType(resolved);

      if (relationMatch == null) {
        throw new CoreError("This relation does not exist", "missing", { entity: "relation" });
      }

      recordRelationActivity(relationMatch, validActor, "relation_delete", Date.now());
      dbRelation.deleteById(relationMatch.id);
      return relationMatch;
    });
  },
  /** Returns relations by created_at ascending, then id ascending, with or without included tasks. */
  getAll: getRelations,
};
