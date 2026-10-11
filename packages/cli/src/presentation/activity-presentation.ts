import type { Activity, ActivityAction, ActivityTaskIdentity } from "@zinn-dev/core";

import {
  activity,
  activityTaskKeySchema,
  column,
  label,
  minimumActivityIdLength,
  project,
  task,
} from "@zinn-dev/core";
import { formatDescriptionPreview } from "./description-presentation";
import { formatRows } from "./row-layout";
import { formatSection } from "./section";
import { formatLocalTime } from "./time";

type NavigationIdentity = {
  name: string;
  status: "current" | "archived" | "deleted" | "recorded";
  distinguishesTaskId?: boolean;
};

export type PresentedActivity = {
  event: Activity;
  displayId: string;
  navigation?: NavigationIdentity;
  removedTasks: Array<ActivityTaskIdentity>;
};

const RECORDED_FIELDS = new Set([
  "id",
  "key",
  "name",
  "title",
  "description",
  "priority",
  "color",
  "column",
  "columns",
  "project",
  "tasks",
  "labels",
  "added",
  "removed",
  "type",
  "source",
  "target",
  "comment",
  "text",
]);

const ENTITY_PREVIEW_LENGTH = 24;
const ACTION_LABELS: Record<ActivityAction, string> = {
  create: "created",
  edit: "edited",
  move: "moved",
  order: "reordered",
  archive: "archived",
  unarchive: "unarchived",
  delete: "deleted",
  relation_create: "added relation",
  relation_delete: "removed relation",
  comment_create: "added comment",
  comment_edit: "edited comment",
  comment_delete: "deleted comment",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function commonPrefixLength(left: string, right: string) {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length++;
  }

  return length;
}

function canonicalPrefix(id: string, hexLength: number) {
  let digits = 0;

  for (let index = 0; index < id.length; index++) {
    if (id[index] !== "-") {
      digits++;
    }
    if (digits === hexLength) {
      return id.slice(0, index + 1);
    }
  }
  return id;
}

/** Neighbors in sorted UUID order determine the shortest globally unique left prefix. */
export function abbreviateActivityIds(ids: Array<string>) {
  const sorted = ids
    .map((id) => ({ id, hex: id.replaceAll("-", "").toLowerCase() }))
    .sort((left, right) => left.hex.localeCompare(right.hex));
  const prefixes = new Map<string, string>();

  for (const [index, entry] of sorted.entries()) {
    const previous = sorted[index - 1]?.hex ?? "";
    const next = sorted[index + 1]?.hex ?? "";
    const length = Math.max(
      minimumActivityIdLength,
      commonPrefixLength(entry.hex, previous) + 1,
      commonPrefixLength(entry.hex, next) + 1,
    );
    prefixes.set(entry.id, canonicalPrefix(entry.id, length));
  }

  return prefixes;
}

function getTaskNavigation(events: Array<Activity>, taskKey?: string) {
  if (taskKey !== undefined) {
    return activity.getTaskIdentities(taskKey);
  }

  const identities = new Map<string, ActivityTaskIdentity>();
  if (events.some((event) => event.entity_type === "task")) {
    for (const item of task.getAll({ archive: "all" })) {
      identities.set(item.id, {
        id: item.id,
        key: item.key,
        title: item.title,
        status: item.archived_at == null ? "active" : "archived",
      });
    }
  }

  const historicalKeys = new Set<string>();
  function addKey(key: unknown) {
    const parsed = activityTaskKeySchema.safeParse(key);
    if (parsed.success) {
      historicalKeys.add(parsed.data);
    }
  }

  for (const event of events) {
    if (event.action !== "delete") {
      continue;
    }

    if (event.entity_type === "task") {
      addKey(event.changes?.key);
    } else if (event.entity_type === "project" && Array.isArray(event.changes?.tasks)) {
      for (const snapshot of event.changes.tasks) {
        if (isRecord(snapshot)) {
          addKey(snapshot.key);
        }
      }
    }
  }
  for (const key of historicalKeys) {
    for (const identity of activity.getTaskIdentities(key)) {
      identities.set(identity.id, identity);
    }
  }

  return [...identities.values()];
}

export function presentActivities(
  events: Array<Activity>,
  options: { taskKey?: string; showsFullIds?: boolean } = {},
): Array<PresentedActivity> {
  if (events.length === 0) {
    return [];
  }

  const prefixes = options.showsFullIds
    ? new Map<string, string>()
    : abbreviateActivityIds(activity.getIds());
  const tasks = getTaskNavigation(events, options.taskKey);
  const tasksById = new Map(tasks.map((identity) => [identity.id, identity]));
  const taskIdsByKey = new Map<string, number>();

  for (const identity of tasks) {
    taskIdsByKey.set(identity.key, (taskIdsByKey.get(identity.key) ?? 0) + 1);
  }

  const projectsById = new Map(project.getAll().map((item) => [item.id, item]));
  const labelsById = events.some((event) => event.entity_type === "label")
    ? new Map(label.getAll().map((item) => [item.id, item]))
    : new Map();
  const navigationByEntity = new Map<string, NavigationIdentity | undefined>();

  return events.map((event) => {
    const entityKey = `${event.entity_type}:${event.entity_id}`;
    let navigation = navigationByEntity.get(entityKey);

    if (!navigationByEntity.has(entityKey)) {
      switch (event.entity_type) {
        case "task": {
          const identity = tasksById.get(event.entity_id);
          if (identity !== undefined) {
            navigation = {
              name: identity.key,
              status: identity.status === "active" ? "current" : identity.status,
              distinguishesTaskId: taskIdsByKey.get(identity.key)! > 1,
            };
          }
          break;
        }
        case "project": {
          const current = projectsById.get(event.entity_id);
          if (current !== undefined) {
            navigation = { name: current.key, status: "current" };
          }
          break;
        }
        case "column": {
          const current = column.getById(event.entity_id);
          if (current != null) {
            navigation = { name: current.name, status: "current" };
          }
          break;
        }
        case "label": {
          const current = labelsById.get(event.entity_id);
          if (current !== undefined) {
            navigation = { name: current.name, status: "current" };
          }
          break;
        }
      }
      navigationByEntity.set(entityKey, navigation);
    }
    const isSnapshot = event.action === "create" || event.action === "delete";
    const recordedName = event.changes?.key ?? event.changes?.name;

    if (navigation === undefined && isSnapshot && typeof recordedName === "string") {
      navigation = { name: recordedName, status: "recorded" };
    }

    const removedTaskIds =
      event.entity_type === "project" &&
      event.action === "delete" &&
      Array.isArray(event.changes?.tasks)
        ? new Set(event.changes.tasks.filter(isRecord).map((snapshot) => snapshot.id))
        : new Set();

    return {
      event,
      displayId: options.showsFullIds ? event.id : prefixes.get(event.id)!,
      navigation,
      removedTasks:
        options.taskKey === undefined
          ? []
          : tasks.filter((identity) => removedTaskIds.has(identity.id)),
    };
  });
}

function formatNavigation(entry: PresentedActivity, options: { showsFullNames?: boolean } = {}) {
  const { event, navigation } = entry;
  if (navigation === undefined) {
    return `${event.entity_type} ${event.entity_id}`;
  }

  const identity = navigation.distinguishesTaskId ? `; ${event.entity_id}` : "";
  const name = options.showsFullNames ? navigation.name : formatDescriptionPreview(navigation.name);
  return `${event.entity_type} ${name} [${navigation.status}${identity}]`;
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value)) {
    const name = value.key ?? value.name ?? value.title ?? value.id;
    if (typeof name === "string") {
      return name;
    }
  }

  return JSON.stringify(value);
}

function isRecordedChangePair(event: Activity, value: unknown): value is [unknown, unknown] {
  return (
    ["edit", "move", "comment_edit"].includes(event.action) &&
    Array.isArray(value) &&
    value.length === 2
  );
}

function formatRemovedTasks(entry: PresentedActivity) {
  return entry.removedTasks.map((identity) => `removed ${identity.key} (${identity.id})`);
}

function formatChangeSummary(
  entry: PresentedActivity,
  options: { showsRemovedTasks?: boolean; omitsIdentity?: boolean } = {},
) {
  const { event } = entry;
  const changes = event.changes;
  let summary = "-";

  if (changes !== null) {
    summary =
      Object.entries(changes)
        .map(([field, value]) => {
          const isSnapshot = event.action === "create" || event.action === "delete";
          if (isSnapshot && value === null) {
            return null;
          }
          const repeatsIdentity =
            options.omitsIdentity &&
            isSnapshot &&
            (field === "key" || field === "name") &&
            value === entry.navigation?.name;
          if (repeatsIdentity) {
            return null;
          }
          if (!RECORDED_FIELDS.has(field)) {
            return `${field}: ${JSON.stringify(value)}`;
          }
          if (field === "description") {
            return event.action === "edit" ? "description changed" : "description recorded";
          }
          if (field === "title" && options.omitsIdentity && isSnapshot) {
            return summarizeValue(value);
          }
          if (isRecordedChangePair(event, value)) {
            return `${field}: ${summarizeValue(value[0])} → ${summarizeValue(value[1])}`;
          }
          if (Array.isArray(value)) {
            if (field === "labels" && value.length === 0) {
              return null;
            }
            return `${field}: ${value.length}`;
          }
          if (field === "labels" && isRecord(value)) {
            const additions =
              Array.isArray(value.added) && value.added.length > 0
                ? `added labels ${value.added.map(summarizeValue).join(", ")}`
                : "";
            const removals =
              Array.isArray(value.removed) && value.removed.length > 0
                ? `removed labels ${value.removed.map(summarizeValue).join(", ")}`
                : "";
            return (
              [additions, removals].filter((part) => part.length > 0).join("; ") ||
              `labels: ${JSON.stringify(value)}`
            );
          }
          if (field === "comment" && isRecord(value)) {
            return `comment ${summarizeValue(value)}${typeof value.text === "string" ? `: ${value.text}` : ""}`;
          }
          return `${field}: ${summarizeValue(value)}`;
        })
        .filter((part) => part !== null)
        .join("; ") || "-";
  }
  const removed = options.showsRemovedTasks === false ? "" : formatRemovedTasks(entry).join("; ");
  return [formatDescriptionPreview(summary), removed].filter((part) => part.length > 0).join("; ");
}

function formatActivityContent(entry: PresentedActivity) {
  const { event, navigation } = entry;
  const name = navigation?.name ?? event.entity_id;
  const shortName = formatDescriptionPreview(name, { maxLength: ENTITY_PREVIEW_LENGTH });
  const entityType =
    event.entity_type === "task" && navigation !== undefined ? "" : `${event.entity_type} `;
  const isMutableCurrentName =
    navigation?.status === "current" &&
    (event.entity_type === "label" || event.entity_type === "column");
  const isProjectDeletion = event.entity_type === "project" && event.action === "delete";
  const provenance =
    isProjectDeletion
      ? " [deleted project]"
      : navigation?.status === "recorded"
        ? " [recorded]"
        : isMutableCurrentName
          ? " [current name]"
          : "";
  const taskIdentity = navigation?.distinguishesTaskId ? ` [${navigation.status} task]` : "";
  const action = ACTION_LABELS[event.action] ?? event.action;
  const summary = formatChangeSummary(entry, { showsRemovedTasks: false, omitsIdentity: true });
  const lines = [
    `${entityType}${shortName}${provenance}${taskIdentity} · ${action}${summary === "-" ? "" : `: ${summary}`}`,
  ];

  if (shortName !== name) {
    const nameLabel =
      navigation === undefined
        ? "Entity ID"
        : event.entity_type === "task" || event.entity_type === "project"
          ? `Full ${event.entity_type} key`
          : `Full ${event.entity_type} name`;
    lines.push(`${nameLabel}: ${name}`);
  }
  if (navigation?.distinguishesTaskId) {
    lines.push(`Task identity: ${navigation.status}; ${event.entity_id}`);
  }
  lines.push(...formatRemovedTasks(entry));
  return lines.join("\n");
}

function formatRecordedValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value
      .map((item, index) => formatSection(`Item ${index + 1}`, formatRecordedValue(item)))
      .join("\n\n");
  }
  if (isRecord(value)) {
    return (
      Object.entries(value)
        .map(([field, item]) =>
          formatSection(
            field,
            RECORDED_FIELDS.has(field) ? formatRecordedValue(item) : JSON.stringify(item, null, 2),
          ),
        )
        .join("\n\n") || "{}"
    );
  }
  return JSON.stringify(value);
}

function formatRecordedChanges(event: Activity) {
  if (event.changes === null) {
    return "null";
  }

  const sections: Array<string> = [];
  const unknownFields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(event.changes)) {
    if (!RECORDED_FIELDS.has(field)) {
      unknownFields[field] = value;
      continue;
    }
    const body = isRecordedChangePair(event, value)
      ? `${formatSection("From", formatRecordedValue(value[0]))}\n\n${formatSection("To", formatRecordedValue(value[1]))}`
      : formatRecordedValue(value);
    sections.push(formatSection(field, body));
  }
  if (Object.keys(unknownFields).length > 0) {
    sections.push(formatSection("Raw JSON", JSON.stringify(unknownFields, null, 2)));
  }
  return sections.join("\n\n") || "{}";
}

export function formatActivityList(
  entries: Array<PresentedActivity>,
  options: { showsDetails?: boolean } = {},
) {
  const rows = entries.map((entry) => {
    const metadata = [
      { text: entry.displayId },
      { text: formatLocalTime(entry.event.created_at), style: "dim" as const },
      { text: `${entry.event.actor_name} (${entry.event.actor_kind})` },
    ];
    if (!options.showsDetails) {
      return [...metadata, { text: formatActivityContent(entry) }];
    }
    return [
      ...metadata,
      { text: formatNavigation(entry, { showsFullNames: true }) },
      { text: entry.event.action },
      { text: formatChangeSummary(entry) },
    ];
  });
  if (!options.showsDetails) {
    return formatRows(rows, { indentsContinuationLines: true });
  }
  return entries
    .map((entry, index) =>
      [
        formatRows([rows[index]!]),
        formatSection("Entity", `${entry.event.entity_type} ${entry.event.entity_id}`),
        ...(entry.navigation === undefined
          ? []
          : [formatSection("Navigation", formatNavigation(entry, { showsFullNames: true }))]),
        formatSection(
          "Actor",
          `${entry.event.actor_name}\nKind: ${entry.event.actor_kind}\nEmail: ${entry.event.actor_email ?? "null"}`,
        ),
        formatSection("Changes", formatRecordedChanges(entry.event)),
      ].join("\n\n"),
    )
    .join("\n\n");
}
