// Typechecked as an outside consumer of the published declarations. It is never run.
import type {
  FailureFacts,
  Activity,
  Actor,
  TaskWithKey,
  TaskPageInput,
  TaskChange,
  TaskOrderManyInput,
  RelationCreateInput,
} from "@zinn-dev/core";
import {
  activity,
  project,
  task,
  relation,
  configureDatabase,
  CoreError,
  InputValidationError,
  SqliteError,
  taskPageSchema,
} from "@zinn-dev/core";

const actor: Actor = { name: "consumer", email: "consumer@example.test", kind: "human" };
configureDatabase({
  client: "consumer",
  version: "1.0.0",
  executable: "consumer.mts",
  release: "source",
});
const createdProject = project.create({ key: "TYPES" }, actor);
const createdTask: TaskWithKey = task.create(
  { project_id: createdProject.id, title: "Declarations", priority: "high" },
  actor,
);
const key: string = createdTask.key;
const taskPageInput: TaskPageInput = { limit: 2, sort: "activity" };
const taskPage = task.getPage(taskPageInput);
const pageTasks: TaskWithKey[] = taskPage.tasks;
const pageHasMore: boolean = taskPage.hasMore;
const nextTaskCursor: string | undefined = taskPage.nextCursor;
task.getPage({ ...taskPageInput, startingAfter: nextTaskCursor });
const parsedTaskPage = taskPageSchema.safeParse({ startingAfter: nextTaskCursor, limit: 1 });
const relationRequest: RelationCreateInput = {
  sourceTaskKey: key,
  targetTaskKey: "TYPES-2",
  relation_type: "subtask",
};
const conflicts = relation.getConflicts(relationRequest);
const conflictSource: TaskWithKey | undefined = conflicts[0]?.source;
relation.create({ ...relationRequest, replace: conflicts.map(({ id }) => id) }, actor);
relation.create({ ...relationRequest, replace: true }, actor);
// @ts-expect-error replacement authorization takes a boolean or relation IDs.
relation.create({ ...relationRequest, replace: "yes" }, actor);
const placement: TaskOrderManyInput = { taskKeys: [key], direction: "top" };
const ordered: TaskChange[] = task.orderMany(placement, actor);
// @ts-expect-error relative task ordering requires a target.
task.orderMany({ taskKeys: [key], direction: "before" }, actor);
const failureFacts: FailureFacts = { entity: "task", key };
const failure: Error = new CoreError("Missing task", "missing", failureFacts);
const validation: Error = new InputValidationError([
  { code: "invalid_type", path: ["title"], message: "Invalid title" },
]);
const sqlite: Error = new SqliteError("Busy", 5, null);
void pageTasks;
void pageHasMore;
void parsedTaskPage;
const page: { events: Activity[]; hasMore: boolean; nextCursor?: string } = activity.getAll({
  sessionId: "conversation",
  threadId: "child",
  actions: ["create", "edit"],
  changed: [
    { field: "column", value: "Review" },
    { field: "priority", value: null },
    { field: "description" },
  ],
  limit: 1,
});
const nextEventCursor: string | undefined = page.nextCursor;
const events: Activity[] = activity.getAll({ startingAfter: page.events[0]?.id }).events;
void nextEventCursor;
// @ts-expect-error only column, priority and labels support changed value filters.
activity.getAll({ changed: [{ field: "comment", value: "text" }] });
// @ts-expect-error column names cannot use null as a changed filter value.
activity.getAll({ changed: [{ field: "column", value: null }] });
// @ts-expect-error free-text fields support only value-free filters.
activity.getAll({ changed: [{ field: "description", value: "text" }] });
// @ts-expect-error action filters use the recorded action vocabulary.
activity.getAll({ actions: ["invalid"] });
// @ts-expect-error priority is a public vocabulary, not an arbitrary string.
task.create({ project_id: createdProject.id, title: "Invalid", priority: "invalid" }, actor);
// @ts-expect-error every mutation requires an explicit actor.
project.create({ key: "INVALID" });
