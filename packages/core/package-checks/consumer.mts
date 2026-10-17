// Typechecked as an outside consumer of the published declarations. It is never run.
import type { FailureFacts, Activity, Actor, TaskWithKey } from "@zinn-dev/core";
import {
  activity,
  project,
  task,
  configureDatabase,
  CoreError,
  InputValidationError,
  SqliteError,
} from "@zinn-dev/core";

const actor: Actor = { name: "consumer", email: "consumer@example.test", kind: "human" };
configureDatabase({
  client: "consumer",
  version: "1.0.0",
  executable: "consumer.mts",
  release: "source",
  allowsLegacyRead: false,
});
const createdProject = project.create({ key: "TYPES" }, actor);
const createdTask: TaskWithKey = task.create(
  { project_id: createdProject.id, title: "Declarations", priority: "high" },
  actor,
);
const key: string = createdTask.key;
const failureFacts: FailureFacts = { entity: "task", key };
const failure: Error = new CoreError("Missing task", "missing", failureFacts);
const validation: Error = new InputValidationError([
  { code: "invalid_type", path: ["title"], message: "Invalid title" },
]);
const sqlite: Error = new SqliteError("Busy", 5, null);
const events: Activity[] = activity.getAll({
  sessionId: "conversation",
  threadId: "child",
  limit: 1,
});
// @ts-expect-error priority is a public vocabulary, not an arbitrary string.
task.create({ project_id: createdProject.id, title: "Invalid", priority: "invalid" }, actor);
// @ts-expect-error every mutation requires an explicit actor.
project.create({ key: "INVALID" });
