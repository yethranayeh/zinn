import type { Column, Task, TaskRelation, TaskWithKey } from "./src/types";
import type { ProjectCreateInput, ProjectEditInput } from "./src/schemas/project";
import type { TaskCreateInput, TaskEditInput } from "./src/schemas/task";
import type { RelationCreateInput, RelationDeleteInput } from "./src/schemas/relation";
import type { LabelCreateInput, LabelDeleteInput, TaskLabelInput } from "./src/schemas/label";

import { randomUUIDv7 } from "bun";
import { generateKeyBetween } from "fractional-indexing";

import { getDb } from "./src/db";
import { labelCreateSchema, labelDeleteSchema, taskLabelSchema } from "./src/schemas/label";

import * as dbProject from "./src/db/project";
import * as dbColumn from "./src/db/column";
import * as dbTask from "./src/db/task";
import * as dbRelation from "./src/db/relation";
import * as dbLabel from "./src/db/label";

import { standardizeProjectKey } from "./src/lib";
import { validateTaskInput, taskCreateSchema, taskEditSchema } from "./src/schemas/task";
import { relationCreateSchema, relationDeleteSchema } from "./src/schemas/relation";

import {
  validateProjectInput,
  projectCreateSchema,
  projectEditSchema,
} from "./src/schemas/project";

export type { ProjectCreateInput, ProjectEditInput } from "./src/schemas/project";
export type { TaskCreateInput, TaskEditInput } from "./src/schemas/task";
export type { TaskWithKey, Label, LabelColor } from "./src/types";
export type { LabelCreateInput, LabelDeleteInput, TaskLabelInput } from "./src/schemas/label";
export type { RelationCreateInput, RelationDeleteInput } from "./src/schemas/relation";

export { labelCreateSchema, labelDeleteSchema, taskLabelSchema } from "./src/schemas/label";
export { projectCreateSchema, projectEditSchema } from "./src/schemas/project";
export { taskCreateSchema, taskEditSchema } from "./src/schemas/task";
export { relationCreateSchema, relationDeleteSchema } from "./src/schemas/relation";

export const project = {
  getById: dbProject.getById,
  getByKey: dbProject.getByKey,
  create: (input: ProjectCreateInput) => {
    const props = validateProjectInput(projectCreateSchema, input);
    const existingProject = dbProject.getByKey(props.key);

    if (existingProject != null) {
      throw new Error(`Project with key "${existingProject.key}" already exists!`);
    }

    const key = standardizeProjectKey(props.key);
    const project = dbProject.create({ key, name: props.name ?? key })!;

    const defaultColumns = ["Backlog", "TODO", "In Progress", "Review", "Done"];
    let lastColumnOrder: string | null = null;

    for (const col of defaultColumns) {
      const columnOrder = generateKeyBetween(lastColumnOrder, null);
      dbColumn.create({
        id: randomUUIDv7(),
        project_id: project?.id,
        name: col,
        column_order: columnOrder,
      })!;
      lastColumnOrder = columnOrder;
    }

    return project;
  },
  /** Rename a project. Same name does not alter the timestamp */
  edit: (input: ProjectEditInput) => {
    const props = validateProjectInput(projectEditSchema, input);
    const projectMatch = dbProject.getByKey(props.projectKey);

    if (projectMatch == null) {
      throw new Error(
        `Project with key "${standardizeProjectKey(props.projectKey)}" does not exist!`,
      );
    }

    if (props.name === projectMatch.name) {
      return projectMatch;
    }

    return dbProject.update({ id: projectMatch.id, name: props.name, updated_at: Date.now() })!;
  },
  getAll: dbProject.getAll,
  delete: (key: string) => {
    const project = dbProject.getByKey(key);

    if (project == null) {
      throw new Error(`Project with key "${key}" does not exist!`);
    }

    dbProject.deleteByKey(key);
    return project;
  },
  standardizeKey: standardizeProjectKey,
};

export const column = {
  getById: dbColumn.getById,
  getAllByProjectKey: (key: string) => {
    const standardizedKey = standardizeProjectKey(key);
    const project = dbProject.getByKey(standardizedKey);

    if (project == null) {
      throw new Error(`Project with key "${key}" does not exist!`);
    }
    return dbColumn.getAllByProjectId(project.id);
  },
  create: (column: Omit<Column, "id" | "project_id" | "column_order"> & { projectKey: string }) => {
    const standardizedKey = standardizeProjectKey(column.projectKey);
    const project = dbProject.getByKey(standardizedKey);

    if (project == null) {
      throw new Error(`Project with key "${standardizedKey}" does not exist!`);
    }

    const allProjectColumns = dbColumn.getAllByProjectId(project.id);
    const existingColumn = allProjectColumns.find(
      (existing) => existing.name.toLowerCase() === column.name.toLowerCase(),
    );

    if (existingColumn != null) {
      throw new Error(
        `Column with name "${column.name}" already exists in project "${project.key}"!`,
      );
    }

    const lastColOrder = allProjectColumns[allProjectColumns.length - 1]?.column_order ?? null;

    return dbColumn.create({
      id: randomUUIDv7(),
      name: column.name,
      column_order: generateKeyBetween(lastColOrder, null),
      project_id: project.id,
    })!;
  },
};

function getTaskByKey(taskKey: string) {
  const taskKeyMatch = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(taskKey);
  if (taskKeyMatch == null) {
    throw new Error(`Invalid task key "${taskKey}". Expected format PROJECT-1`);
  }

  const projectKey = taskKeyMatch[1]!;
  const taskNumber = Number(taskKeyMatch[2]);
  if (!Number.isSafeInteger(taskNumber) || taskNumber < 1) {
    throw new Error(`Invalid task key "${taskKey}". Expected format PROJECT-1`);
  }

  const project = dbProject.getByKey(projectKey);

  if (project == null) {
    throw new Error(`Project with key "${standardizeProjectKey(projectKey)}" does not exist!`);
  }

  const taskMatch = dbTask.getByProjectIdAndNumber({
    projectId: project.id,
    number: taskNumber,
  });

  if (taskMatch == null) {
    throw new Error(`Task "${project.key}-${taskNumber}" does not exist!`);
  }

  return attachTaskKey(taskMatch, project.key);
}

type TaskOrderProps =
  | {
      taskKey: string;
      direction: "top" | "up" | "down" | "bottom";
      targetTaskKey?: never;
    }
  | {
      taskKey: string;
      direction: "before" | "after";
      targetTaskKey: string;
    };

function attachTaskKey(task: Task, projectKey?: string): TaskWithKey {
  const key = projectKey ?? dbProject.getById(task.project_id)!.key;
  return { ...task, key: `${key}-${task.number}` };
}

function resolveLabels(names: Array<string>) {
  const uniqueNames = [...new Set(names)];
  return uniqueNames.map((name) => {
    const match = dbLabel.getByName(name);
    if (match == null) {
      throw new Error(`A label with name "${name}" does not exist`);
    }

    return match;
  });
}

export const task = {
  create: (input: TaskCreateInput) => {
    const task = validateTaskInput(taskCreateSchema, input);

    return getDb().transaction(() => {
      const labels = resolveLabels(task.labelNames ?? []);
      const project = dbProject.getById(task.project_id);
      const counter = dbProject.incrementTaskCounterById(task.project_id);

      if (project == null || counter == null) {
        throw new Error(
          `Project's next task number could not be retrieved  (ID:${task.project_id})`,
        );
      }

      const initialColumn = dbColumn.getAllByProjectId(task.project_id)[0];
      if (initialColumn == null) {
        throw new Error(`Project "${project.key}" does not have any columns`);
      }

      const lastTask = dbTask.getLastByColumnId(initialColumn.id);
      const order = generateKeyBetween(lastTask?.task_order ?? null, null);

      const now = Date.now();
      const createdTask = dbTask.create({
        id: randomUUIDv7(),
        project_id: task.project_id,
        column_id: initialColumn.id,
        number: counter.task_count,
        title: task.title,
        description: task.description,
        task_order: order,
        created_at: now,
        updated_at: now,
      })!;

      for (const label of labels) {
        dbTask.addLabel(createdTask.id, label.id);
      }

      return attachTaskKey(createdTask, project.key);
    })();
  },
  getAll: (props: { projectKey?: string; archive?: dbTask.TaskArchiveFilter } = {}) => {
    if (props.projectKey == null) {
      return dbTask.getAll(props.archive).map((task) => attachTaskKey(task));
    }

    const taskProject = dbProject.getByKey(props.projectKey);

    if (taskProject == null) {
      throw new Error(`Project with key "${props.projectKey}" does not exist!`);
    }

    return dbTask
      .getAllByProjectId(taskProject.id, props.archive)
      .map((task) => attachTaskKey(task, taskProject.key));
  },
  getByKey: getTaskByKey,
  label: {
    getAll: (taskKey: string) => dbTask.getLabels(getTaskByKey(taskKey).id),
    add: (input: TaskLabelInput): TaskWithKey => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, addLabelNames: props.labelNames });
    },
    remove: (input: TaskLabelInput): TaskWithKey => {
      const props = validateTaskInput(taskLabelSchema, input);
      return task.edit({ taskKey: props.taskKey, removeLabelNames: props.labelNames });
    },
  },
  /** Edit supplied content fields, including on archived tasks. Unchanged edits are no-ops. */
  edit: (input: TaskEditInput) => {
    const props = validateTaskInput(taskEditSchema, input);
    return getDb().transaction(() => {
      const existing = getTaskByKey(props.taskKey);
      const additions = resolveLabels(props.addLabelNames ?? []);
      const removals = resolveLabels(props.removeLabelNames ?? []);
      const existingLabelIds = new Set(dbTask.getLabels(existing.id).map((label) => label.id));
      const labelsToAdd = additions.filter((label) => !existingLabelIds.has(label.id));
      const labelsToRemove = removals.filter((label) => existingLabelIds.has(label.id));
      const areLabelsUnchanged = labelsToAdd.length === 0 && labelsToRemove.length === 0;
      const isTitleUnchanged = props.title === undefined || props.title === existing.title;
      const isDescriptionUnchanged =
        props.description === undefined || props.description === existing.description;

      if (isTitleUnchanged && isDescriptionUnchanged && areLabelsUnchanged) {
        return existing;
      }

      for (const label of labelsToAdd) {
        dbTask.addLabel(existing.id, label.id);
      }

      for (const label of labelsToRemove) {
        dbTask.removeLabel(existing.id, label.id);
      }

      return {
        ...dbTask.update({
          id: existing.id,
          title: props.title,
          description: props.description,
          updated_at: Date.now(),
        })!,
        key: existing.key,
      };
    })();
  },
  /**
   * Moves a task to another column in its project.
   *
   * Moving a task to a different column lists it last in that column,
   *  matching placement at the bottom of a visual kanban column.
   * Giving a task's current column as the target will not do anything.
   * Archived tasks must be unarchived before they can be moved.
   */
  move: (props: { taskKey: string; targetColumn: string }) => {
    const taskMatch = getTaskByKey(props.taskKey);

    if (taskMatch.archived_at != null) {
      throw new Error(`Archived task "${props.taskKey}" cannot be moved`);
    }

    const columnMatch = dbColumn
      .getAllByProjectId(taskMatch.project_id)
      .find((column) => column.name.toLowerCase() === props.targetColumn.toLowerCase());

    if (columnMatch == null) {
      // TODO: maybe a `did you mean` type of fuzzy check for misspelllings
      throw new Error(
        `Column "${props.targetColumn}" does not exist in task "${props.taskKey}"'s project!`,
      );
    }

    if (columnMatch.id === taskMatch.column_id) {
      return taskMatch;
    }

    const lastTask = dbTask.getLastByColumnId(columnMatch.id);
    const order = generateKeyBetween(lastTask?.task_order ?? null, null);

    return {
      ...dbTask.update({
        id: taskMatch.id,
        column_id: columnMatch.id,
        task_order: order,
        updated_at: Date.now(),
      })!,
      key: taskMatch.key,
    };
  },
  order: (props: TaskOrderProps) => {
    const { taskKey, direction } = props;
    const taskMatch = getTaskByKey(taskKey);

    if (taskMatch.archived_at != null) {
      throw new Error(`Archived task "${taskKey}" cannot be reordered`);
    }

    const allTasks = dbTask.getAllByColumnId(taskMatch.column_id);
    const taskIndex = allTasks.findIndex((candidate) => candidate.id === taskMatch.id);
    const otherTasks = allTasks.filter((candidate) => candidate.id !== taskMatch.id);
    let insertionIndex: number;

    switch (direction) {
      case "top":
        insertionIndex = 0;
        break;
      case "up":
        insertionIndex = Math.max(0, taskIndex - 1);
        break;
      case "down":
        insertionIndex = Math.min(otherTasks.length, taskIndex + 1);
        break;
      case "bottom":
        insertionIndex = otherTasks.length;
        break;
      case "before":
      case "after": {
        const targetTask = getTaskByKey(props.targetTaskKey);

        if (targetTask.id === taskMatch.id) {
          return taskMatch;
        }

        if (targetTask.project_id !== taskMatch.project_id) {
          throw new Error(
            `Tasks "${taskKey}" and "${props.targetTaskKey}" must be in the same project`,
          );
        }

        if (targetTask.column_id !== taskMatch.column_id) {
          throw new Error(
            `Tasks "${taskKey}" and "${props.targetTaskKey}" must be in the same column`,
          );
        }

        if (targetTask.archived_at != null) {
          throw new Error(`Archived task "${props.targetTaskKey}" cannot be an ordering target`);
        }

        const targetIndex = otherTasks.findIndex((candidate) => candidate.id === targetTask.id);
        insertionIndex = direction === "before" ? targetIndex : targetIndex + 1;
        break;
      }
    }

    if (insertionIndex === taskIndex) {
      return taskMatch;
    }

    const futurePrevTask = otherTasks[insertionIndex - 1] ?? null;
    const futureNextTask = otherTasks[insertionIndex] ?? null;

    return {
      ...dbTask.update({
        id: taskMatch.id,
        task_order: generateKeyBetween(
          futurePrevTask?.task_order ?? null,
          futureNextTask?.task_order ?? null,
        ),
        updated_at: Date.now(),
      })!,
      key: taskMatch.key,
    };
  },
  delete: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);
    dbTask.deleteById(taskMatch.id);

    return taskMatch;
  },
  archive: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);

    if (taskMatch.archived_at != null) {
      return taskMatch;
    }

    const now = Date.now();

    return {
      ...dbTask.update({ id: taskMatch.id, updated_at: now, archived_at: now })!,
      key: taskMatch.key,
    };
  },
  unarchive: (taskKey: string) => {
    const taskMatch = getTaskByKey(taskKey);

    if (taskMatch.archived_at == null) {
      return taskMatch;
    }

    const lastTask = dbTask.getLastByColumnId(taskMatch.column_id);
    const order = generateKeyBetween(lastTask?.task_order ?? null, null);

    return {
      ...dbTask.update({
        id: taskMatch.id,
        task_order: order,
        updated_at: Date.now(),
        archived_at: null,
      })!,
      key: taskMatch.key,
    };
  },
};

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
  create: (input: RelationCreateInput) => {
    const props = validateTaskInput(relationCreateSchema, input);
    const resolved = resolveRelationTaskIds(props);

    const relationMatch = dbRelation.getByTaskIdsAndType(resolved);

    if (relationMatch != null) {
      throw new Error("This relation already exists");
    }

    return dbRelation.create(resolved);
  },
  delete: (input: RelationDeleteInput) => {
    const props = validateTaskInput(relationDeleteSchema, input);

    const resolved = resolveRelationTaskIds(props);
    const relationMatch = dbRelation.getByTaskIdsAndType(resolved);

    if (relationMatch == null) {
      throw new Error("This relation does not exist");
    }

    dbRelation.deleteById(relationMatch.id);
    return relationMatch;
  },
  getAll: getRelations,
};

export const label = {
  create: (input: LabelCreateInput) => {
    const props = validateTaskInput(labelCreateSchema, input);

    if (dbLabel.getByName(props.name) != null) {
      throw new Error(`A label with name "${props.name}" already exists`);
    }

    return dbLabel.create({
      name: props.name,
      description: props.description ?? "",
      color: props.color ?? "white",
    })!;
  },
  getAll: dbLabel.getAll,
  getByName: (name: string) => {
    const props = validateTaskInput(labelDeleteSchema, { name });
    return dbLabel.getByName(props.name);
  },
  delete: (input: LabelDeleteInput) => {
    const props = validateTaskInput(labelDeleteSchema, input);
    return getDb().transaction(() => {
      const match = resolveLabels([props.name])[0]!;
      dbTask.updateLabelTasksTimestamp(match.id, Date.now());
      dbLabel.deleteById(match.id);
      return match;
    })();
  },
};
