import { CoreError } from "../errors.js";
import type { ActivityChangedField, ActivityListInput } from "../schemas/activity.js";
import type { Activity } from "../types.js";

import { activityIdSchema, activityListSchema } from "../schemas/activity.js";
import { validateTaskInput } from "../schemas/task.js";
import { standardizeName, standardizeProjectKey } from "../lib.js";
import { attachTaskKey, findTaskByExactKey } from "./shared.js";
import * as dbActivity from "../db/activity.js";
import * as dbTask from "../db/task.js";
import * as dbProject from "../db/project.js";
import * as dbColumn from "../db/column.js";

export type ActivityTaskIdentity = {
  id: string;
  key: string;
  title: string;
  status: "active" | "archived" | "deleted";
};

type ActivityTaskSelector = Pick<ActivityListInput, "taskKey" | "taskId" | "showDeleted">;
type ActivityProjectSelector = Pick<ActivityListInput, "projectKey" | "projectId" | "showDeleted">;

function resolveProjectHistory({ projectKey, projectId, showDeleted }: ActivityProjectSelector) {
  const projectIds = new Set<string>();
  if (projectId !== undefined) {
    projectIds.add(projectId);
  } else if (projectKey !== undefined) {
    const currentProject = dbProject.getByKey(projectKey);

    if (currentProject == null && showDeleted !== true) {
      throw new CoreError(`Project "${projectKey}" does not exist`, "missing", {
        entity: "project",
        key: projectKey,
      });
    }

    if (currentProject != null) {
      projectIds.add(currentProject.id);
    }
  }

  const events = dbActivity.getAll();
  if (projectKey !== undefined && showDeleted === true) {
    for (const event of events) {
      const isProjectSnapshot =
        event.entity_type === "project" && (event.action === "create" || event.action === "delete");
      if (
        isProjectSnapshot &&
        typeof event.changes?.key === "string" &&
        standardizeProjectKey(event.changes.key) === projectKey
      ) {
        projectIds.add(event.entity_id);
      }
    }
  }

  const columnIds = new Set<string>();
  const taskIds = new Set<string>();

  for (const id of projectIds) {
    for (const entry of dbColumn.getAllByProjectId(id)) {
      columnIds.add(entry.id);
    }

    for (const entry of dbTask.getAllByProjectId(id, "all")) {
      taskIds.add(entry.id);
    }
  }

  for (const event of events) {
    if (event.entity_type === "project" && projectIds.has(event.entity_id)) {
      for (const [field, ids] of [
        ["columns", columnIds],
        ["tasks", taskIds],
      ] as const) {
        const snapshots = event.changes?.[field];
        if (Array.isArray(snapshots)) {
          for (const snapshot of snapshots) {
            if (typeof snapshot?.id === "string") {
              ids.add(snapshot.id);
            }
          }
        }
      }
    }

    const recordedProject = event.changes?.project;
    const recordedProjectId =
      recordedProject != null && typeof recordedProject === "object" && "id" in recordedProject
        ? recordedProject.id
        : undefined;

    if (
      event.entity_type === "column" &&
      event.action === "create" &&
      typeof recordedProjectId === "string" &&
      projectIds.has(recordedProjectId)
    ) {
      columnIds.add(event.entity_id);
    }
  }

  // Column UUIDs establish ownership even when a task was deleted before its project.
  for (const event of events) {
    if (event.entity_type !== "task") {
      continue;
    }

    const recordedColumn = event.changes?.column;
    const columns =
      event.action === "move" && Array.isArray(recordedColumn)
        ? recordedColumn
        : event.action === "create"
          ? [recordedColumn]
          : [];

    if (columns.some((entry) => typeof entry?.id === "string" && columnIds.has(entry.id))) {
      taskIds.add(event.entity_id);
    }
  }

  return events.filter((event) => {
    switch (event.entity_type) {
      case "project":
        return projectIds.has(event.entity_id);
      case "column":
        return columnIds.has(event.entity_id);
      case "task":
        return taskIds.has(event.entity_id);
      default:
        return false;
    }
  });
}

function resolveTaskHistory({ taskKey, taskId, showDeleted }: ActivityTaskSelector) {
  const identities = new Map<string, ActivityTaskIdentity>();
  const projectDeletionIds: Array<string> = [];
  let currentTask = taskKey === undefined ? null : findTaskByExactKey(taskKey);
  if (taskId !== undefined) {
    const taskById = dbTask.getById(taskId);
    currentTask = taskById == null ? null : attachTaskKey(taskById);
  }

  const selectsCurrentTask = taskKey !== undefined && showDeleted !== true;
  if (selectsCurrentTask && currentTask == null) {
    throw new CoreError(`Task "${taskKey}" does not exist`, "missing", {
      entity: "task",
      key: taskKey,
    });
  }

  if (currentTask != null) {
    identities.set(currentTask.id, {
      id: currentTask.id,
      key: currentTask.key,
      title: currentTask.title,
      status: currentTask.archived_at == null ? "active" : "archived",
    });
  }

  if (selectsCurrentTask) {
    return { identities: [...identities.values()], projectDeletionIds };
  }

  function addSnapshot(id: unknown, key: unknown, title: unknown) {
    const isMatchingSnapshot =
      typeof id === "string" &&
      typeof key === "string" &&
      typeof title === "string" &&
      (taskId === undefined ? standardizeProjectKey(key) === taskKey : id === taskId);

    if (!isMatchingSnapshot) {
      return false;
    }

    if (!identities.has(id)) {
      identities.set(id, { id, key, title, status: "deleted" });
    }
    return true;
  }

  for (const event of dbActivity.getTaskDeletionEvents()) {
    if (event.entity_type === "task") {
      addSnapshot(event.entity_id, event.changes?.key, event.changes?.title);
    } else if (Array.isArray(event.changes?.tasks)) {
      for (const snapshot of event.changes.tasks) {
        if (snapshot != null && addSnapshot(snapshot.id, snapshot.key, snapshot.title)) {
          projectDeletionIds.push(event.id);
        }
      }
    }
  }

  return { identities: [...identities.values()], projectDeletionIds };
}

type RecordedValues = Partial<Record<ActivityChangedField, Array<string | null>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The new value in a `[before, after]` change. */
function getRecordedNewValue(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  return value[1];
}

function getRecordedColumnNames(value: unknown): Array<string> {
  if (!isRecord(value) || typeof value.name !== "string") {
    return [];
  }

  return [value.name];
}

function getRecordedNullableText(value: unknown): Array<string | null> {
  if (value !== null && typeof value !== "string") {
    return [];
  }

  return [value];
}

function getRecordedLabelNames(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((name): name is string => typeof name === "string");
}

function getChangedLabelNames(value: unknown, change: "added" | "removed"): Array<string> {
  if (!isRecord(value)) {
    return [];
  }

  return getRecordedLabelNames(value[change]);
}

/**
 * The values a task event records as the new value of each filterable field.
 * Changes are parsed from stored JSON, so unrecognized shapes yield no values.
 */
function getRecordedValues(event: Activity): RecordedValues {
  if (event.entity_type !== "task") {
    return {};
  }

  const changes = event.changes;
  switch (event.action) {
    case "create":
      return {
        column: getRecordedColumnNames(changes?.column),
        priority: getRecordedNullableText(changes?.priority),
        labels: getRecordedLabelNames(changes?.labels),
        title: typeof changes?.title === "string" ? [changes.title] : [],
        description: getRecordedNullableText(changes?.description),
      };
    case "move":
      return { column: getRecordedColumnNames(getRecordedNewValue(changes?.column)) };
    case "edit": {
      const newTitle = getRecordedNewValue(changes?.title);
      return {
        priority: getRecordedNullableText(getRecordedNewValue(changes?.priority)),
        labels: getChangedLabelNames(changes?.labels, "added"),
        title: typeof newTitle === "string" ? [newTitle] : [],
        description: getRecordedNullableText(getRecordedNewValue(changes?.description)),
      };
    }
    default:
      return {};
  }
}

export const activity = {
  getAll: (input: ActivityListInput = {}) => {
    const props = validateTaskInput(activityListSchema, input);
    let events;

    if (props.projectKey !== undefined || props.projectId !== undefined) {
      events = resolveProjectHistory(props);
    } else if (props.taskKey === undefined && props.taskId === undefined) {
      events = dbActivity.getAll();
    } else {
      const { identities, projectDeletionIds } = resolveTaskHistory(props);
      events = dbActivity.getAllForTasks(
        props.taskId === undefined ? identities.map((identity) => identity.id) : [props.taskId],
        projectDeletionIds,
      );
    }

    const changedValues = new Map<ActivityChangedField, Set<string | null | undefined>>();
    for (const { field, value } of props.changed ?? []) {
      const values = changedValues.get(field) ?? new Set<string | null | undefined>();
      values.add(value == null ? value : standardizeName(value));
      changedValues.set(field, values);
    }
    const changedFields = [...changedValues];

    const matchingEvents = events.filter((event) => {
      const matchesTime =
        (props.since === undefined || event.created_at >= props.since) &&
        (props.until === undefined || event.created_at <= props.until);
      const matchesSession =
        props.sessionId === undefined || event.actor_session_id === props.sessionId;

      const matchesThread =
        props.threadId === undefined || event.actor_thread_id === props.threadId;
      const matchesAction = props.actions === undefined || props.actions.includes(event.action);

      const recordedValues = getRecordedValues(event);
      const matchesChanges = changedFields.every(([field, values]) => {
        const newValues = recordedValues[field] ?? [];
        const hasRemovedLabels =
          field === "labels" &&
          event.entity_type === "task" &&
          event.action === "edit" &&
          getChangedLabelNames(event.changes?.labels, "removed").length > 0;
        const matchesAnyChange =
          values.has(undefined) && (newValues.length > 0 || hasRemovedLabels);

        return (
          matchesAnyChange ||
          newValues.some((value) => values.has(value === null ? null : standardizeName(value)))
        );
      });

      return matchesTime && matchesSession && matchesThread && matchesAction && matchesChanges;
    });

    return props.limit === undefined ? matchingEvents : matchingEvents.slice(0, props.limit);
  },
  getById: (id: string) => {
    const hexPrefix = validateTaskInput(activityIdSchema, id);
    const matches = dbActivity.getByIdPrefix(hexPrefix);

    if (matches.length === 0) {
      throw new CoreError(`No activity matches "${id}"`, "missing", {
        entity: "activity",
        key: id,
      });
    }

    if (matches.length > 1) {
      throw new CoreError(
        `Activity ID "${id}" is ambiguous. Candidates: ${matches.map((event) => event.id).join(", ")}. Provide more characters`,
        "conflict",
        {
          entity: "activity",
          key: id,
          reason: "ambiguous_reference",
          matchCount: matches.length,
          candidateIds: matches.map((event) => event.id),
        },
      );
    }

    return matches[0]!;
  },
  getIds: dbActivity.getIds,
  getTaskIdentities: (input: string | ActivityTaskSelector) => {
    const props = validateTaskInput(
      activityListSchema,
      typeof input === "string" ? { taskKey: input } : input,
    );

    return resolveTaskHistory(props).identities;
  },
};
