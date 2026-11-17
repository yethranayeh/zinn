import { expect, test } from "bun:test";
import { applyConflictChoices, changedEdits, editValues } from "../src/inspector/edit-draft";

test("keeping a draft adopts the reviewed expected value without changing other fields", () => {
  const base = { title: "A", description: "original", priority: "high" };
  const draft = { ...base, title: "B", description: "my description" };
  const saved = { title: "C", description: "another description", priority: "low" };
  const resolved = applyConflictChoices(base, draft, saved, { title: "draft" });

  expect(resolved.base).toEqual({ ...base, title: "C" });
  expect(changedEdits(resolved.base, resolved.values)).toEqual({ title: "B", description: "my description" });
  expect(base.title).toBe("A");
  expect(draft.title).toBe("B");
  expect(saved.title).toBe("C");
});

test("adopting saved values removes only the chosen edits and preserves later draft editing", () => {
  const base = { title: "A", description: "original", priority: "high" };
  const draft = { title: "B edited during review", description: "my description", priority: null };
  const saved = { title: "C", description: "saved description", priority: "low" };
  const resolved = applyConflictChoices(base, draft, saved, { title: "draft", description: "saved", priority: "saved" });

  expect(changedEdits(resolved.base, resolved.values)).toEqual({ title: "B edited during review" });
  expect(resolved.base).toEqual(saved);
  expect(resolved.values).toEqual({ ...saved, title: "B edited during review" });
});

test("untouched external changes never become draft edits after conflict review", () => {
  const base = { title: "A", description: "original", priority: null };
  const draft = { ...base, title: "B" };
  const saved = { title: "C", description: "external", priority: "urgent" };
  const resolved = applyConflictChoices(base, draft, saved, { title: "draft" });

  expect(changedEdits(resolved.base, resolved.values)).toEqual({ title: "B" });
  expect(resolved.base.description).toBe("original");
  expect(resolved.base.priority).toBeNull();
});

test("review can be repeated against another saved value without overwriting the draft", () => {
  const base = { title: "A", description: "", priority: null };
  const draft = { ...base, title: "B" };
  const first = applyConflictChoices(base, draft, { ...base, title: "C" }, { title: "draft" });
  const second = applyConflictChoices(first.base, first.values, { ...base, title: "D" }, { title: "saved" });

  expect(first.base.title).toBe("C");
  expect(first.values.title).toBe("B");
  expect(second.base.title).toBe("D");
  expect(changedEdits(second.base, second.values)).toEqual({});
});

test("empty descriptions and cleared priorities remain meaningful draft and expected values", () => {
  const base = editValues({ title: "A", description: null, priority: null });
  expect(base).toEqual({ title: "A", description: "", priority: null });
  const draft = { ...base, description: "", priority: null };
  const saved = { ...base, description: "external", priority: "low" };
  const kept = applyConflictChoices(base, draft, saved, { description: "draft", priority: "draft" });

  expect(kept.base).toEqual(saved);
  expect(changedEdits(kept.base, kept.values)).toEqual({ description: "", priority: null });
  const adopted = applyConflictChoices(kept.base, kept.values, saved, { description: "saved", priority: "saved" });
  expect(changedEdits(adopted.base, adopted.values)).toEqual({});
});
