import type { ActivityListInput } from "../schemas/activity";

import { activityIdSchema, activityListSchema, activityTaskKeySchema } from "../schemas/activity";
import { validateTaskInput } from "../schemas/task";
import { standardizeProjectKey } from "../lib";
import { findTaskByExactKey } from "./shared";
import * as dbActivity from "../db/activity";

export type ActivityTaskIdentity = {
  id: string;
  key: string;
  title: string;
  status: "active" | "archived" | "deleted";
};

function resolveTaskHistory(taskKey: string) {
  const identities = new Map<string, ActivityTaskIdentity>();
  const projectDeletionIds: Array<string> = [];
  const currentTask = findTaskByExactKey(taskKey);

  if (currentTask != null) {
    identities.set(currentTask.id, {
      id: currentTask.id,
      key: currentTask.key,
      title: currentTask.title,
      status: currentTask.archived_at == null ? "active" : "archived",
    });
  }

  function addSnapshot(id: unknown, key: unknown, title: unknown) {
    const isMatchingSnapshot =
      typeof id === "string" &&
      typeof key === "string" &&
      typeof title === "string" &&
      standardizeProjectKey(key) === taskKey;

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

export const activity = {
  getAll: (input: ActivityListInput = {}) => {
    const props = validateTaskInput(activityListSchema, input);
    let events;

    if (props.taskKey === undefined) {
      events = dbActivity.getAll();
    } else {
      const { identities, projectDeletionIds } = resolveTaskHistory(props.taskKey);
      events = dbActivity.getAllForTasks(
        identities.map((identity) => identity.id),
        projectDeletionIds,
      );
    }

    return props.limit === undefined ? events : events.slice(0, props.limit);
  },
  getById: (id: string) => {
    const hexPrefix = validateTaskInput(activityIdSchema, id);
    const matches = dbActivity.getByIdPrefix(hexPrefix);

    if (matches.length === 0) {
      throw new Error(`No activity matches "${id}"`);
    }

    if (matches.length > 1) {
      throw new Error(
        `Activity ID "${id}" is ambiguous. Candidates: ${matches.map((event) => event.id).join(", ")}. Provide more characters`,
      );
    }

    return matches[0]!;
  },
  getIds: dbActivity.getIds,
  getTaskIdentities: (taskKey: string) => {
    const normalizedKey = validateTaskInput(activityTaskKeySchema, taskKey);
    return resolveTaskHistory(normalizedKey).identities;
  },
};
