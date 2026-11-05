import type { Activity, TaskAttribution, TaskBlame } from "../types.js";

import { readTransaction } from "../db.js";
import * as dbActivity from "../db/activity.js";
import * as dbColumn from "../db/column.js";
import * as dbTask from "../db/task.js";
import * as dbTaskLabel from "../db/task-label.js";
import * as dbRelation from "../db/relation.js";
import { attachTaskKey, getTaskByKey } from "./shared.js";
import { attributeLines, descriptionLines } from "../line-attribution.js";

function toAttribution(event: Activity): TaskAttribution {
  const { entity_type, entity_id, action, changes, ...attribution } = event;
  return attribution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** The label names a create action records, recognized only as an array of names. */
function isRecordedLabelNames(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
}

/** The label delta an edit action records, name arrays for added and removed and at least one entry. */
function isRecordedLabelDelta(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const added = value.added;
  const removed = value.removed;
  return (
    isRecordedLabelNames(added) &&
    isRecordedLabelNames(removed) &&
    (added.length > 0 || removed.length > 0)
  );
}

/** Who last set each field, the label set and the parent, plus per-line description provenance. */
export function blameTask(taskKey: string): TaskBlame {
  return readTransaction(() => {
    const current = getTaskByKey(taskKey);
    const history = dbActivity.getAllByEntity("task", current.id);
    const labels = dbTaskLabel.getAllByTaskId(current.id).map(({ id, name }) => ({ id, name }));
    const column = dbColumn.getById(current.column_id)!;
    const relations = dbRelation.getAllByTaskId(current.id);
    const setters = new Map<string, { value: unknown; attribution: TaskAttribution | null }>();
    let labelAttribution: TaskAttribution | null = null;
    let parentSetter: { value: unknown; attribution: TaskAttribution | null } | undefined;
    const relationEvents = new Map<string, Activity>();
    let description: string | null | undefined;
    let lineAttributions: Array<TaskAttribution | null> = [];

    for (const event of history) {
      const changes = isRecord(event.changes) ? event.changes : null;
      const attribution = toAttribution(event);
      const isCreation = event.action === "create";
      if (isCreation || event.action === "edit" || event.action === "move") {
        for (const field of ["title", "column", "priority", "due_at"] as const) {
          if (isCreation || (changes !== null && Object.hasOwn(changes, field))) {
            const snapshot = changes?.[field];
            const value = isCreation
              ? snapshot
              : Array.isArray(snapshot) && snapshot.length === 2
                ? snapshot[1]
                : undefined;
            const comparable =
              field === "column" ? (isRecord(value) ? value.id : undefined) : value;
            setters.set(field, {
              value: comparable,
              attribution: comparable === undefined ? null : attribution,
            });
          }
        }
        if (isCreation || (changes !== null && Object.hasOwn(changes, "labels"))) {
          const snapshot = changes?.labels;
          const valid = isCreation
            ? isRecordedLabelNames(snapshot)
            : isRecordedLabelDelta(snapshot);
          labelAttribution = valid ? attribution : null;
        }
        if (isCreation || (changes !== null && Object.hasOwn(changes, "description"))) {
          const snapshot = changes?.description;
          if (isCreation) {
            description = isText(snapshot) ? snapshot : undefined;
            lineAttributions = descriptionLines(description ?? null).map(() => attribution);
          } else if (
            Array.isArray(snapshot) &&
            snapshot.length === 2 &&
            isText(snapshot[0]) &&
            isText(snapshot[1])
          ) {
            const [oldText, newText] = snapshot;
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
      }
      if (isCreation) {
        parentSetter = { value: null, attribution };
      }
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
      }
    }

    function attributionFor(field: string, value: unknown) {
      const setter = setters.get(field);
      return setter !== undefined && setter.value === value ? setter.attribution : null;
    }
    const blamedRelations = relations.map((entry) => {
      const outgoing = entry.source_task_id === current.id;
      const other = attachTaskKey(
        dbTask.getById(outgoing ? entry.target_task_id : entry.source_task_id)!,
      );
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
            : outgoing
              ? ("outgoing" as const)
              : ("incoming" as const),
        task: { id: other.id, key: other.key },
        attribution: matchesCreation ? toAttribution(event) : null,
      };
    });
    const parent = blamedRelations.find(
      (entry) => entry.type === "subtask" && entry.direction === "outgoing",
    );
    const parentAttribution =
      parent === undefined
        ? parentSetter?.value === null
          ? parentSetter.attribution
          : null
        : parentSetter?.value === parent.task.id
          ? parent.attribution
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
        labels: { value: labels, attribution: labelAttribution },
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
