import type {
  ActivityChangedField,
  ActivityListInput,
  ActivityTaskIdentitiesInput,
} from "../schemas/activity.js";
import type { Activity } from "../types.js";

import { CoreError } from "../errors.js";
import {
  activityIdSchema,
  activityListSchema,
  activityTaskIdentitiesSchema,
} from "../schemas/activity.js";
import { parseTaskKey, validateTaskInput } from "../schemas/task.js";
import { parseClientChain } from "../schemas/actor.js";
import { timestampSchema } from "../schemas/timestamp.js";
import { standardizeName, standardizeProjectKey } from "../lib.js";
import { attachTaskKey, findTaskByExactKey, requireSingleIdMatch } from "./shared.js";
import { getDb } from "../db.js";
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

/** The last resolved project members, valid while the connection and its write marker stay the same */
let lastProjectMembers:
  | {
      connection: ReturnType<typeof getDb>;
      selector: string;
      writeMarker: string;
      members: dbActivity.ActivityMembers;
    }
  | undefined;

/** Resolves project members once for repeated reads of the same selection, such as a page and its navigation */
function getProjectMembers(selection: ActivityProjectSelector) {
  const connection = getDb();
  const selector = JSON.stringify([
    selection.projectKey,
    selection.projectId,
    selection.showDeleted === true,
  ]);
  const writeMarker = dbActivity.getWriteMarker();
  const isReusable =
    lastProjectMembers?.connection === connection &&
    lastProjectMembers.selector === selector &&
    lastProjectMembers.writeMarker === writeMarker;

  if (!isReusable) {
    lastProjectMembers = {
      connection,
      selector,
      writeMarker,
      members: resolveProjectMembers(selection),
    };
  }

  return lastProjectMembers!.members;
}

/** Finds the projects, columns and tasks whose events form the selected project history */
function resolveProjectMembers({
  projectKey,
  projectId,
  showDeleted,
}: ActivityProjectSelector): dbActivity.ActivityMembers {
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

    if (showDeleted === true) {
      for (const id of dbActivity.getProjectIdsByRecordedKey(projectKey)) {
        projectIds.add(id);
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

  const projectEvents = dbActivity.getAll({
    members: { projectIds: [...projectIds], columnIds: [], taskIds: [] },
  });
  for (const event of projectEvents) {
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

  for (const id of dbActivity.getColumnIdsCreatedInProjects([...projectIds])) {
    columnIds.add(id);
  }

  // Column UUIDs establish ownership even when a task was deleted before its project.
  for (const id of dbActivity.getTaskIdsRecordedInColumns([...columnIds])) {
    taskIds.add(id);
  }

  return { projectIds: [...projectIds], columnIds: [...columnIds], taskIds: [...taskIds] };
}

/** Deleted task snapshots recording one of the IDs or keys, newest first, with their deletion events */
function getDeletedTaskSnapshots({ taskIds = [], taskKeys = [] }: dbActivity.TaskDeletionMatch) {
  const ids = new Set(taskIds);
  const keys = new Set(taskKeys);

  return dbActivity.getTaskDeletionEvents({ taskIds, taskKeys }).flatMap((event) => {
    const recorded: Array<Record<string, unknown>> =
      event.entity_type === "task"
        ? [{ id: event.entity_id, key: event.changes?.key, title: event.changes?.title }]
        : Array.isArray(event.changes?.tasks)
          ? event.changes.tasks.filter(isRecord)
          : [];

    return recorded.flatMap(({ id, key, title }) => {
      const isMatchingSnapshot =
        typeof id === "string" &&
        typeof key === "string" &&
        typeof title === "string" &&
        (ids.has(id) || keys.has(standardizeProjectKey(key)));

      return isMatchingSnapshot
        ? [{ event, identity: { id, key, title, status: "deleted" as const } }]
        : [];
    });
  });
}

/** Task keys in the stored form, such as APP-1 for app-1 */
function toStoredTaskKeys(taskKeys: Array<string>) {
  return taskKeys.map((key) => {
    const { projectKey, taskNumber } = parseTaskKey(key)!;
    return `${projectKey}-${taskNumber}`;
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

  const snapshots = getDeletedTaskSnapshots(
    taskId === undefined ? { taskKeys: [taskKey!] } : { taskIds: [taskId] },
  );
  for (const { event, identity } of snapshots) {
    if (!identities.has(identity.id)) {
      identities.set(identity.id, identity);
    }
    if (event.entity_type === "project") {
      projectDeletionIds.push(event.id);
    }
  }

  return { identities: [...identities.values()], projectDeletionIds };
}

type RecordedValues = Partial<Record<ActivityChangedField, Array<string | number | null>>>;

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

function getRecordedDeadline(value: unknown): Array<number | null> {
  const parsed = timestampSchema.nullable().safeParse(value);
  return parsed.success ? [parsed.data] : [];
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
        due_at: getRecordedDeadline(changes?.due_at),
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
        due_at: getRecordedDeadline(getRecordedNewValue(changes?.due_at)),
      };
    }
    default:
      return {};
  }
}

export const activity = {
  getAll: (
    input: ActivityListInput = {},
  ): { events: Array<Activity>; hasMore: boolean; nextCursor?: string } => {
    const props = validateTaskInput(activityListSchema, input);
    const query: dbActivity.ActivityQuery = {
      sessionId: props.sessionId,
      threadId: props.threadId,
      since: props.since,
      until: props.until,
      actions: props.actions,
      before: props.startingAfter === undefined ? undefined : activity.getById(props.startingAfter),
    };
    let fetchCandidates = (input: dbActivity.ActivityQuery) => dbActivity.getAll(input);

    if (props.projectKey !== undefined || props.projectId !== undefined) {
      query.members = getProjectMembers(props);
    } else if (props.taskKey !== undefined || props.taskId !== undefined) {
      const { identities, projectDeletionIds } = resolveTaskHistory(props);
      const taskIds =
        props.taskId === undefined ? identities.map((identity) => identity.id) : [props.taskId];
      fetchCandidates = (input) => dbActivity.getAllForTasks(taskIds, projectDeletionIds, input);
    }

    const changedValues = new Map<ActivityChangedField, Set<string | null | undefined>>();
    for (const { field, value } of props.changed ?? []) {
      const values = changedValues.get(field) ?? new Set<string | null | undefined>();
      values.add(value == null ? value : standardizeName(value));
      changedValues.set(field, values);
    }
    const changedFields = [...changedValues];

    const matchesClient = (event: Activity) => {
      if (props.client === undefined) {
        return true;
      }

      return parseClientChain(event.actor_client).some(
        ({ name }) => name === props.client || name.startsWith(`${props.client}:`),
      );
    };

    const matchesChanges = (event: Activity) => {
      const recordedValues = getRecordedValues(event);

      return changedFields.every(([field, values]) => {
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
          newValues.some(
            (value) =>
              typeof value !== "number" &&
              values.has(value === null ? null : standardizeName(value)),
          )
        );
      });
    };

    const matchesFilters = (event: Activity) => matchesClient(event) && matchesChanges(event);

    if (props.limit === undefined) {
      return { events: fetchCandidates(query).filter(matchesFilters), hasMore: false };
    }

    const matchingEvents: Array<Activity> = [];
    const matchesNeeded = props.limit + 1;
    query.limit = matchesNeeded;

    while (matchingEvents.length < matchesNeeded) {
      const candidates = fetchCandidates(query);

      for (const event of candidates) {
        if (matchesFilters(event)) {
          matchingEvents.push(event);
          if (matchingEvents.length === matchesNeeded) {
            break;
          }
        }
      }

      if (candidates.length < query.limit) {
        break;
      }
      query.before = candidates.at(-1)!;
    }

    const events = matchingEvents.slice(0, props.limit);
    if (matchingEvents.length <= props.limit) {
      return { events, hasMore: false };
    }

    // Events never change position, so the last event's ID continues the list
    return { events, hasMore: true, nextCursor: events.at(-1)!.id };
  },
  getById: (id: string) => {
    const hexPrefix = validateTaskInput(activityIdSchema, id);
    return requireSingleIdMatch("activity", id, dbActivity.getByIdPrefix(hexPrefix));
  },
  getIds: dbActivity.getIds,
  getTaskIdentities: (input: string | ActivityTaskSelector) => {
    const props = validateTaskInput(
      activityListSchema,
      typeof input === "string" ? { taskKey: input } : input,
    );

    return resolveTaskHistory(props).identities;
  },
  /** Existing tasks, active and archived, matching any given ID or key. Reads no history. */
  getCurrentTaskIdentities: (input: ActivityTaskIdentitiesInput): Array<ActivityTaskIdentity> => {
    const props = validateTaskInput(activityTaskIdentitiesSchema, input);
    const taskIds = props.taskIds ?? [];
    const keys = toStoredTaskKeys(props.taskKeys ?? []);
    const rows = [
      ...(taskIds.length === 0 ? [] : dbTask.getAllByIds(taskIds)),
      ...(keys.length === 0 ? [] : dbTask.getAllByKeys(keys)),
    ];
    const identities = new Map<string, ActivityTaskIdentity>();

    for (const { project_key, ...row } of rows) {
      const item = attachTaskKey(row, project_key);
      identities.set(item.id, {
        id: item.id,
        key: item.key,
        title: item.title,
        status: item.archived_at == null ? "active" : "archived",
      });
    }

    return [...identities.values()];
  },
  /** Deleted tasks matching any given ID or key, each with its newest recorded snapshot. */
  getDeletedTaskIdentities: (input: ActivityTaskIdentitiesInput): Array<ActivityTaskIdentity> => {
    const props = validateTaskInput(activityTaskIdentitiesSchema, input);
    const taskIds = props.taskIds ?? [];
    const taskKeys = toStoredTaskKeys(props.taskKeys ?? []);
    if (taskIds.length === 0 && taskKeys.length === 0) {
      return [];
    }

    const identities = new Map<string, ActivityTaskIdentity>();
    for (const { identity } of getDeletedTaskSnapshots({ taskIds, taskKeys })) {
      if (!identities.has(identity.id)) {
        identities.set(identity.id, identity);
      }
    }

    return [...identities.values()];
  },
};
