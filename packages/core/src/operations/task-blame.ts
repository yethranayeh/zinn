import type { Activity, TaskAttribution, TaskBlame } from "../types.js";

import { readTransaction } from "../db.js";
import * as dbActivity from "../db/activity.js";
import * as dbColumn from "../db/column.js";
import * as dbTask from "../db/task.js";
import * as dbTaskLabel from "../db/task-label.js";
import * as dbRelation from "../db/relation.js";
import {
  getChangedLabelNames,
  getRecordedLabelNames,
  getRecordedNewValue,
  getRecordedNullableText,
  isRecord,
} from "./recorded-changes.js";
import { attachTaskKey, getTaskByKey } from "./shared.js";
import { attributeLines, descriptionLines } from "../line-attribution.js";

/** The task events blame replays. Comment events can hold large text it would parse and ignore. */
const REPLAYED_ACTIONS: Array<Activity["action"]> = [
  "create",
  "edit",
  "move",
  "relation_create",
  "relation_delete",
];

function toAttribution(event: Activity): TaskAttribution {
  const { entity_type, entity_id, action, changes, ...attribution } = event;
  return attribution;
}

/** Who last set each field, the label set and the parent, plus per-line description provenance. */
export function blameTask(taskKey: string): TaskBlame {
  return readTransaction(() => {
    const current = getTaskByKey(taskKey);
    const history = dbActivity.getAllByEntity("task", current.id, REPLAYED_ACTIONS);
    const labels = dbTaskLabel.getAllByTaskId(current.id).map(({ id, name }) => ({ id, name }));
    const column = dbColumn.getById(current.column_id)!;
    const relations = dbRelation.getAllByTaskId(current.id);
    const setters = new Map<string, { value: unknown; attribution: TaskAttribution | null }>();
    let labelAttribution: TaskAttribution | null = null;
    // Label names can be renamed, so the count is what recorded changes can check against the current set.
    let recordedLabelCount: number | null = null;
    let parentSetter: { value: unknown; attribution: TaskAttribution | null } | undefined;
    const relationEvents = new Map<string, Activity>();
    let description: string | null | undefined;
    let lineAttributions: Array<TaskAttribution | null> = [];

    for (const event of history) {
      const changes = isRecord(event.changes) ? event.changes : null;
      const attribution = toAttribution(event);

      if (event.action === "relation_create" || event.action === "relation_delete") {
        const sourceChange = changes?.source;
        const targetChange = changes?.target;
        const source = isRecord(sourceChange) ? sourceChange.id : undefined;
        const target = isRecord(targetChange) ? targetChange.id : undefined;
        const type = changes?.type;
        if (typeof source === "string" && typeof target === "string" && typeof type === "string") {
          relationEvents.set(JSON.stringify([source, target, type]), event);
          if (type === "subtask" && source === current.id) {
            parentSetter = {
              value: event.action === "relation_create" ? target : null,
              attribution,
            };
          }
        } else {
          parentSetter = undefined;
        }
        continue;
      }

      const isCreation = event.action === "create";
      const recordsField = (field: string) =>
        isCreation || (changes !== null && Object.hasOwn(changes, field));

      for (const field of ["title", "column", "priority", "due_at"] as const) {
        if (recordsField(field)) {
          const value = isCreation ? changes?.[field] : getRecordedNewValue(changes?.[field]);
          const comparable = field === "column" ? (isRecord(value) ? value.id : undefined) : value;
          setters.set(field, {
            value: comparable,
            attribution: comparable === undefined ? null : attribution,
          });
        }
      }

      if (recordsField("labels")) {
        const snapshot = changes?.labels;
        if (isCreation) {
          recordedLabelCount = Array.isArray(snapshot)
            ? getRecordedLabelNames(snapshot).length
            : null;
        } else {
          const addedCount = getChangedLabelNames(snapshot, "added").length;
          const removedCount = getChangedLabelNames(snapshot, "removed").length;
          const isRecognizedChange = addedCount + removedCount > 0;
          recordedLabelCount =
            recordedLabelCount !== null && isRecognizedChange
              ? recordedLabelCount + addedCount - removedCount
              : null;
        }
        labelAttribution = recordedLabelCount === null ? null : attribution;
      }

      if (recordsField("description")) {
        const snapshot = changes?.description;
        const versions =
          Array.isArray(snapshot) && snapshot.length === 2
            ? snapshot.flatMap((version) => getRecordedNullableText(version))
            : [];

        if (isCreation) {
          [description] = getRecordedNullableText(snapshot);
          lineAttributions = descriptionLines(description ?? null).map(() => attribution);
        } else if (versions.length === 2) {
          const [oldText, newText] = versions as [string | null, string | null];
          const oldLines = descriptionLines(oldText);
          if (description === undefined || description !== oldText) {
            lineAttributions = oldLines.map(() => null);
          }
          lineAttributions = attributeLines(
            oldLines,
            descriptionLines(newText),
            lineAttributions,
            attribution,
          );
          description = newText;
        } else {
          description = undefined;
          lineAttributions = [];
        }
      }

      if (isCreation) {
        parentSetter = { value: null, attribution };
      }
    }

    function attributionFor(field: string, value: unknown) {
      const setter = setters.get(field);
      return setter !== undefined && setter.value === value ? setter.attribution : null;
    }

    const otherTaskId = (entry: (typeof relations)[number]) =>
      entry.source_task_id === current.id ? entry.target_task_id : entry.source_task_id;
    const otherKeys = new Map(
      dbTask
        .getAllByIds(relations.map(otherTaskId))
        .map((row) => [row.id, attachTaskKey(row, row.project_key).key]),
    );
    const blamedRelations = relations.map((entry) => {
      const otherId = otherTaskId(entry);
      const event = relationEvents.get(
        JSON.stringify([entry.source_task_id, entry.target_task_id, entry.relation_type]),
      );
      // A relation's create operation allocates its ID before its endpoint events.
      const matchesCreation =
        event?.action === "relation_create" &&
        event.created_at === entry.created_at &&
        event.id > entry.id;
      return {
        id: entry.id,
        type: entry.relation_type,
        direction:
          entry.relation_type === "related"
            ? null
            : entry.source_task_id === current.id
              ? ("outgoing" as const)
              : ("incoming" as const),
        task: { id: otherId, key: otherKeys.get(otherId)! },
        attribution: matchesCreation ? toAttribution(event) : null,
      };
    });
    const parent = blamedRelations.find(
      (entry) => entry.type === "subtask" && entry.direction === "outgoing",
    );
    // The current link's own event names who set a parent, and the latest setter names who cleared one.
    const parentAttribution =
      parentSetter?.value === (parent?.task.id ?? null)
        ? (parent ?? parentSetter).attribution
        : null;
    const currentLines = descriptionLines(current.description);
    return {
      task: { id: current.id, key: current.key },
      fields: {
        title: { value: current.title, attribution: attributionFor("title", current.title) },
        column: {
          value: { id: column.id, name: column.name },
          attribution: attributionFor("column", column.id),
        },
        priority: {
          value: current.priority,
          attribution: attributionFor("priority", current.priority),
        },
        due_at: { value: current.due_at, attribution: attributionFor("due_at", current.due_at) },
        labels: {
          value: labels,
          attribution: recordedLabelCount === labels.length ? labelAttribution : null,
        },
        parent: { value: parent?.task ?? null, attribution: parentAttribution },
      },
      relations: blamedRelations,
      description: currentLines.map((text, index) => ({
        line: index + 1,
        text,
        attribution: description === current.description ? (lineAttributions[index] ?? null) : null,
      })),
    };
  });
}
