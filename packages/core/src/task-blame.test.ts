import { expect, spyOn, test } from "bun:test";
import { column, label, project, relation, task, CoreError, type TaskAttribution } from "../index";
import { getDb } from "./db";
import { withTestStore } from "./testing";
import { attributeLines } from "./line-attribution";

const human = { name: "Original Human", email: "human@example.test", kind: "human" as const };
const agent = { name: "worker@1", email: null, kind: "agent" as const, source: "declared",
  sessionId: "session-a", threadId: "thread-a", agent: "worker", model: "model-a", effort: "high", client: "adapter/1 cli/2" };

function seed(description: string | null = "one\ntwo\nthree") {
  const app = project.create({ key: "APP" }, human);
  const entry = task.create({ project_id: app.id, title: "Original", description, priority: "high", due_at: 10 }, human);
  return { app, entry };
}
function latest(key: string) {
  return task.activity(key).at(-1)!;
}
function rewrite(id: string, changes: unknown) {
  getDb().query("UPDATE activity SET changes = ? WHERE id = ?").run(JSON.stringify(changes), id);
}
function owners(key: string) {
  return task.blame(key).description.map(line => line.attribution?.id ?? null);
}

test("creation, setters, no-ops, nullable clears and archived reads retain complete stored identity without writes", () => {
  withTestStore(() => {
    const { entry } = seed();
    const creation = latest(entry.key);
    const initial = task.blame(entry.key);
    expect(initial.task).toEqual({ id: entry.id, key: entry.key });
    for (const field of Object.values(initial.fields)) {
      expect(field.attribution?.id).toBe(creation.id);
    }
    expect(owners(entry.key)).toEqual([creation.id, creation.id, creation.id]);
    task.edit({ taskKey: entry.key, title: "Changed", priority: null, due_at: null }, agent);
    const edit = latest(entry.key);
    expect(task.edit({ taskKey: entry.key, title: "Changed", priority: null, due_at: null }, human).changed).toBe(false);
    task.archive(entry.key, human);
    const before = getDb().query("SELECT total_changes() AS changes").get();
    const history = task.activity(entry.key);
    const result = task.blame(entry.key);
    expect(result.fields.title).toEqual({ value: "Changed", attribution: {
      id: edit.id, created_at: edit.created_at, actor_name: agent.name, actor_email: null, actor_kind: "agent",
      actor_source: agent.source, actor_session_id: agent.sessionId, actor_thread_id: agent.threadId,
      actor_agent: agent.agent, actor_model: agent.model, actor_effort: agent.effort, actor_client: agent.client,
    } });
    expect(result.fields.priority).toEqual({ value: null, attribution: result.fields.title.attribution });
    expect(result.fields.due_at).toEqual({ value: null, attribution: result.fields.title.attribution });
    expect(task.activity(entry.key)).toEqual(history);
    expect(getDb().query("SELECT total_changes() AS changes").get()).toEqual(before);
    getDb().query("UPDATE activity SET actor_name = ?, actor_source = NULL, actor_session_id = NULL WHERE id = ?")
      .run(" old host@0 ", edit.id);
    expect(task.blame(entry.key).fields.title.attribution).toMatchObject({ actor_name: " old host@0 ", actor_source: null, actor_session_id: null });
  });
});

test("moves and label membership use current definition names without assigning rename authors", () => {
  withTestStore(() => {
    const { app, entry } = seed();
    task.move({ taskKey: entry.key, targetColumn: "Done" }, agent);
    const move = latest(entry.key);
    column.edit({ projectKey: app.key, columnName: "Done", name: "Finished" }, human);
    expect(task.blame(entry.key).fields.column).toEqual({ value: { id: task.getByKey(entry.key).column_id, name: "Finished" }, attribution: task.blame(entry.key).fields.column.attribution });
    expect(task.blame(entry.key).fields.column.attribution?.id).toBe(move.id);
    label.create({ name: "alpha" }, human);
    label.create({ name: "zeta" }, human);
    task.label.add({ taskKey: entry.key, labelNames: ["zeta", "alpha"] }, agent);
    const added = latest(entry.key);
    label.edit({ labelName: "alpha", name: "beta" }, human);
    expect(task.blame(entry.key).fields.labels.value.map(label => label.name)).toEqual(["beta", "zeta"]);
    expect(task.blame(entry.key).fields.labels.attribution?.id).toBe(added.id);
    task.label.remove({ taskKey: entry.key, labelNames: ["beta"] }, human);
    expect(task.blame(entry.key).fields.labels.attribution?.id).toBe(latest(entry.key).id);
    task.label.add({ taskKey: entry.key, labelNames: ["beta"] }, agent);
    expect(task.blame(entry.key).fields.labels.attribution?.actor_session_id).toBe(agent.sessionId);
    label.delete({ name: "beta" }, human);
    expect(task.blame(entry.key).fields.labels.value.map(label => label.name)).toEqual(["zeta"]);
    expect(task.blame(entry.key).fields.labels.attribution?.id).toBe(latest(entry.key).id);
  });
});

test("parents, children and directed or symmetric links use only the current endpoint event", () => {
  withTestStore(() => {
    const { app, entry } = seed();
    const others = Array.from({ length: 5 }, (_, index) => task.create({ project_id: app.id, title: `Other ${index}` }, human));
    const parentInput = { sourceTaskKey: entry.key, targetTaskKey: others[0]!.key, relation_type: "subtask" as const };
    relation.create(parentInput, agent);
    expect(task.blame(entry.key).fields.parent.value?.id).toBe(others[0]!.id);
    expect(task.blame(others[0]!.key).relations[0]).toMatchObject({ direction: "incoming", task: { id: entry.id } });
    relation.create({ ...parentInput, targetTaskKey: others[1]!.key, replace: true }, human);
    expect(task.blame(entry.key).fields.parent.attribution?.actor_name).toBe(human.name);
    relation.delete({ ...parentInput, targetTaskKey: others[1]!.key }, agent);
    expect(task.blame(entry.key).fields.parent).toMatchObject({ value: null, attribution: { id: latest(entry.key).id } });
    const inputs = [
      { sourceTaskKey: entry.key, targetTaskKey: others[2]!.key, relation_type: "dependency" as const },
      { sourceTaskKey: others[3]!.key, targetTaskKey: entry.key, relation_type: "duplicate" as const },
      { sourceTaskKey: others[4]!.key, targetTaskKey: entry.key, relation_type: "related" as const },
    ];
    for (const input of inputs) {
      relation.create(input, agent);
    }
    expect(task.blame(entry.key).relations.map(link => link.direction)).toEqual(["outgoing", "incoming", null]);
    expect(task.blame(entry.key).relations.every(link => link.attribution?.actor_session_id === agent.sessionId)).toBe(true);
    const original = task.blame(entry.key).relations[0]!;
    relation.delete(inputs[0]!, human);
    const recreated = relation.create(inputs[0]!, human);
    const current = task.blame(entry.key).relations.find(link => link.id === recreated.id)!;
    expect(current.id).not.toBe(original.id);
    expect(current.attribution?.id).not.toBe(original.attribution?.id);
    getDb().query("DELETE FROM activity WHERE id = ?").run(current.attribution!.id);
    expect(task.blame(entry.key).relations.find(link => link.id === recreated.id)!.attribution).toBeNull();
  });
});

test("deleting a parent records the null assignment on the surviving task", () => {
  withTestStore(() => {
    const { app, entry } = seed();
    const parent = task.create({ project_id: app.id, title: "Parent" }, human);
    relation.create({ sourceTaskKey: entry.key, targetTaskKey: parent.key, relation_type: "subtask" }, human);
    task.delete(parent.key, agent);
    expect(task.blame(entry.key).fields.parent).toMatchObject({ value: null, attribution: { actor_name: agent.name } });
    expect(task.blame(entry.key).relations).toEqual([]);
  });
});

test("line replay carries exact whitespace, insertions, deletions, replacements and terminal newline edits", () => {
  withTestStore(() => {
    const { entry } = seed("one\n\n two \nthree\n");
    const creation = latest(entry.key);
    task.edit({ taskKey: entry.key, description: "one\ninserted\n\n two \nthree\n" }, agent);
    const insertion = latest(entry.key);
    expect(owners(entry.key)).toEqual([creation.id, insertion.id, creation.id, creation.id, creation.id]);
    task.edit({ taskKey: entry.key, description: "one\ninserted\n replacement \nthree" }, human);
    const replacement = latest(entry.key);
    expect(owners(entry.key)).toEqual([creation.id, insertion.id, replacement.id, creation.id]);
    expect(task.blame(entry.key).description.map(line => [line.line, line.text])).toEqual([[1, "one"], [2, "inserted"], [3, " replacement "], [4, "three"]]);
    task.edit({ taskKey: entry.key, description: "one\ninserted\n replacement \nthree\n" }, agent);
    expect(owners(entry.key)).toEqual([creation.id, insertion.id, replacement.id, creation.id]);
    task.edit({ taskKey: entry.key, description: "" }, human);
    expect(task.blame(entry.key).description).toEqual([]);
    task.edit({ taskKey: entry.key, description: null }, agent);
    expect(task.blame(entry.key).description).toEqual([]);
  });
});

test("incomplete and contradictory setters never find an older matching actor", () => {
  withTestStore(() => {
    const { entry } = seed();
    task.edit({ taskKey: entry.key, title: "Second", description: "one\nchanged\nthree" }, agent);
    const edit = latest(entry.key);
    rewrite(edit.id, { title: ["Original", "Unrecorded"], description: ["gap\nchanged\nthree", "one\nchanged\nthree"] });
    const result = task.blame(entry.key);
    expect(result.fields.title.attribution).toBeNull();
    expect(owners(entry.key)).toEqual([edit.id, null, null]);
    rewrite(edit.id, { title: "Second", description: { new: "one\nchanged\nthree" } });
    expect(task.blame(entry.key).fields.title.attribution).toBeNull();
    expect(owners(entry.key)).toEqual([null, null, null]);
    task.edit({ taskKey: entry.key, description: "one\nchanged\nnew" }, human);
    const next = latest(entry.key);
    expect(owners(entry.key)).toEqual([null, null, next.id]);
    getDb().query("UPDATE task SET description = ? WHERE id = ?").run("one\nchanged\nnew\nextra", entry.id);
    expect(owners(entry.key)).toEqual([null, null, null, null]);
    getDb().query("DELETE FROM activity WHERE entity_id = ?").run(entry.id);
    const missing = task.blame(entry.key);
    expect(Object.values(missing.fields).every(field => field.attribution === null)).toBe(true);
  });
});

test("a missing creation seeds edits with unknown provenance and ID ordering resolves timestamp ties", () => {
  withTestStore(() => {
    const { entry } = seed();
    const creation = latest(entry.key);
    task.edit({ taskKey: entry.key, description: "one\nsecond\nthree", title: "Second", due_at: 20 }, agent);
    const first = latest(entry.key);
    task.edit({ taskKey: entry.key, description: "one\nsecond\nthird", title: "Third", due_at: 30 }, human);
    const second = latest(entry.key);
    getDb().query("DELETE FROM activity WHERE id = ?").run(creation.id);
    getDb().query("UPDATE activity SET created_at = 0 WHERE entity_id = ?").run(entry.id);
    expect(owners(entry.key)).toEqual([null, first.id, second.id]);
    expect(task.blame(entry.key).fields.title.attribution?.id).toBe(second.id);
    expect(task.blame(entry.key).fields.due_at.attribution?.id).toBe(second.id);
    expect(task.blame(entry.key).fields.parent.attribution).toBeNull();
  });
});

test("deleted and reused keys select only the current task lifetime", () => {
  withTestStore(() => {
    const { app, entry } = seed();
    project.delete(app.key, human);
    expect(() => task.blame(entry.key)).toThrow(CoreError);
    const next = project.create({ key: app.key }, agent);
    const recreated = task.create({ project_id: next.id, title: entry.title }, agent);
    const result = task.blame(entry.key);
    expect(result.task).toEqual({ id: recreated.id, key: entry.key });
    expect(result.task.id).not.toBe(entry.id);
    expect(result.fields.title.attribution?.actor_name).toBe(agent.name);
    expect(() => task.blame("APP-999")).toThrow(CoreError);
  });
});

const original: TaskAttribution = { id: "original", created_at: 0, actor_name: "original", actor_kind: "human",
  actor_email: null, actor_source: null, actor_session_id: null, actor_thread_id: null,
  actor_agent: null, actor_model: null, actor_effort: null, actor_client: null };
const edited = { ...original, id: "edited" };

test("duplicate line ties trim prefix and suffix before preferring deletion in the middle", () => {
  expect(attributeLines(["a", "b"], ["b", "a"], [original, original], edited).map(owner => owner?.id))
    .toEqual(["original", "edited"]);
  expect(attributeLines(["b", "a"], ["a", "a"], [original, original], edited).map(owner => owner?.id))
    .toEqual(["edited", "original"]);
  expect(attributeLines(["a", "a"], ["a"], [original, edited], edited)).toEqual([original]);
});

test("small repeated-line inputs preserve a longest common subsequence", () => {
  const sequences = Array.from({ length: 6 }, (_, length) => Array.from({ length: 2 ** length }, (_, mask) => Array.from({ length }, (_, bit) => (mask >> bit) & 1 ? "a" : "b"))).flat();
  for (const before of sequences) {
    for (const after of sequences) {
      const lengths = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
      for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex--) {
        for (let newIndex = after.length - 1; newIndex >= 0; newIndex--) {
          lengths[oldIndex]![newIndex] = before[oldIndex] === after[newIndex]
            ? 1 + lengths[oldIndex + 1]![newIndex + 1]!
            : Math.max(lengths[oldIndex + 1]![newIndex]!, lengths[oldIndex]![newIndex + 1]!);
        }
      }
      const previous = before.map((_, index) => ({ ...original, id: String(index) }));
      const result = attributeLines(before, after, previous, edited);
      const matches = result.flatMap((owner, index) => owner!.id === edited.id ? [] : [[Number(owner!.id), index]]);
      expect(matches).toHaveLength(lengths[0]![0]!);
      expect(matches.every(([oldIndex, newIndex], index) => before[oldIndex!] === after[newIndex!] && (index === 0 || matches[index - 1]![0]! < oldIndex!))).toBe(true);
    }
  }
});

test("near-cap text handles local edits, repeated lines and wholly changed descriptions", () => {
  withTestStore(() => {
    const lines = Array.from({ length: 28_000 }, (_, index) => `line ${index} content for attribution`);
    const { entry } = seed(lines.join("\n"));
    const creation = latest(entry.key);
    lines[14_000] = "replaced middle";
    lines.splice(20_000, 0, "inserted line");
    task.edit({ taskKey: entry.key, description: lines.join("\n") }, agent);
    const edit = latest(entry.key);
    const result = task.blame(entry.key);
    expect(result.description).toHaveLength(lines.length);
    expect(result.description.filter(line => line.attribution?.id === edit.id)).toHaveLength(2);
    expect(result.description[0]!.attribution?.id).toBe(creation.id);
    const replacement = Array.from({ length: 28_000 }, (_, index) => `entirely new ${index}`);
    task.edit({ taskKey: entry.key, description: replacement.join("\n") }, human);
    expect(new Set(owners(entry.key))).toEqual(new Set([latest(entry.key).id]));
    const repeated = Array.from({ length: 40_000 }, (_, index) => index % 2 ? "repeat-a" : "repeat-b");
    task.edit({ taskKey: entry.key, description: repeated.join("\n") }, agent);
    repeated.splice(20_000, 1);
    task.edit({ taskKey: entry.key, description: repeated.join("\n") }, human);
    expect(task.blame(entry.key).description).toHaveLength(repeated.length);
  });
});


test("same-millisecond relation recreation with missing events cannot reuse the prior link author", () => {
  withTestStore(() => {
    const { app, entry } = seed();
    const other = task.create({ project_id: app.id, title: "Other" }, human);
    const input = { sourceTaskKey: entry.key, targetTaskKey: other.key, relation_type: "subtask" as const };
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const old = relation.create(input, human);
      const oldEvent = latest(entry.key);
      relation.delete(input, agent);
      const recreated = relation.create(input, agent);
      expect(recreated.created_at).toBe(old.created_at);
      expect(task.blame(entry.key).fields.parent.attribution?.id).toBe(latest(entry.key).id);
      getDb().query("DELETE FROM activity WHERE entity_id = ? AND id > ?").run(entry.id, oldEvent.id);
      const result = task.blame(entry.key);
      expect(result.relations[0]!.id).toBe(recreated.id);
      expect(result.relations[0]!.attribution).toBeNull();
      expect(result.fields.parent.attribution).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});
