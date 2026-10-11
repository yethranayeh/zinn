import type { Activity } from "@zinn-dev/core";

import { expect, test } from "bun:test";
import { abbreviateActivityIds, formatActivityList } from "./activity-presentation";

test("activity abbreviations are shortest unique canonical prefixes across all supplied IDs", () => {
  const first = "019abcdf-1234-7000-8000-123456abcde1";
  const second = "019abcdf-1234-7000-8000-123456abcde2";
  const earlier = "019abcdf-0234-7000-8000-123456abcde1";
  const separate = "019abcda-1234-7000-8000-123456abcde1";
  const prefixes = abbreviateActivityIds([second, separate, first, earlier]);
  expect(prefixes.get(first)).toBe(first);
  expect(prefixes.get(second)).toBe(second);
  expect(prefixes.get(earlier)).toBe("019abcdf-0");
  expect(prefixes.get(separate)).toBe("019abcda");
  expect(abbreviateActivityIds([first]).get(first)).toBe("019abcdf");
});

test("activity text keeps full task identities when a long reused key needs disambiguation", () => {
  const event: Activity = {
    id: "019abcdf-1234-7000-8000-123456abcde1", created_at: 1,
    actor_name: "Test", actor_email: null, actor_kind: "human",
    entity_type: "task", entity_id: "019abcdf-1234-7000-8000-123456abcde2",
    action: "archive", changes: null,
  };
  const text = formatActivityList([{ event, displayId: "019abcdf", removedTasks: [],
    navigation: { name: `${"A".repeat(100)}-1`, status: "deleted", distinguishesTaskId: true } }]);
  expect(text).toContain(event.entity_id);
  expect(text).toContain("deleted");
  expect(text).toContain("archive");
});

test("activity details keep explicit empty containers distinct from null changes", () => {
  const event: Activity = {
    id: "019abcdf-1234-7000-8000-123456abcde1", created_at: 1,
    actor_name: "Test", actor_email: null, actor_kind: "human",
    entity_type: "task", entity_id: "019abcdf-1234-7000-8000-123456abcde2",
    action: "create", changes: { labels: [], column: {} },
  };
  const entry = { event, displayId: event.id, removedTasks: [],
    navigation: { name: "APP-1", status: "current" as const } };
  const text = formatActivityList([entry], { showsDetails: true });
  expect(text).toContain("labels:\n[]");
  expect(text).toContain("column:\n{}");
  expect(formatActivityList([{ ...entry, event: { ...event, changes: null } }], { showsDetails: true }))
    .toContain("Changes:\nnull");
});

test("task rows for a shared key mark only deleted tasks and keep every task ID", () => {
  const event: Activity = {
    id: "019abcdf-1234-7000-8000-123456abcde1", created_at: 1,
    actor_name: "Test", actor_email: null, actor_kind: "human",
    entity_type: "task", entity_id: "current-task", action: "edit", changes: null,
  };
  const identities = [
    { id: "current-task", status: "current" as const },
    { id: "archived-task", status: "archived" as const },
    { id: "first-deleted-task", status: "deleted" as const },
    { id: "second-deleted-task", status: "deleted" as const },
  ];
  for (const identity of identities) {
    const entry = {
      event: { ...event, entity_id: identity.id }, displayId: event.id, removedTasks: [],
      navigation: { name: "APP-1", status: identity.status, distinguishesTaskId: true },
    };
    const text = formatActivityList([entry]);
    expect(text.split("\n")[0]!.split(" · ")[0]!.includes("deleted")).toBe(identity.status === "deleted");
    expect(text).toContain(identity.id);
  }
});

test("project deletion keeps its project and removed-task identities visible", () => {
  const event: Activity = {
    id: "019abcdf-1234-7000-8000-123456abcde1", created_at: 1,
    actor_name: "Test", actor_email: null, actor_kind: "human",
    entity_type: "project", entity_id: "old-project", action: "delete",
    changes: { key: "APP", tasks: [{ id: "old-task", key: "APP-1", title: "Old task" }] },
  };
  const text = formatActivityList([{
    event, displayId: event.id,
    navigation: { name: "APP", status: "deleted" },
    removedTasks: [{ id: "old-task", key: "APP-1", title: "Old task", status: "deleted" }],
  }]);
  expect(text.split("\n")[0]!.split(" · ")[0]).toContain("deleted");
  expect(text).toContain("APP-1");
  expect(text).toContain("old-task");
});

test("long entity identities do not pad neighboring activity descriptions", () => {
  const event: Activity = {
    id: "019abcdf-1234-7000-8000-123456abcde1", created_at: 1,
    actor_name: "Test", actor_email: null, actor_kind: "human",
    entity_type: "task", entity_id: "task-id", action: "archive", changes: null,
  };
  const short = { event, displayId: "019abcdf", removedTasks: [],
    navigation: { name: "APP-1", status: "archived" as const } };
  const longKey = "PB137E58A84AC41B5A704693239312DF2";
  const outlier = { ...short, displayId: "019abcda",
    event: { ...event, id: "019abcda-1234-7000-8000-123456abcde1", entity_type: "project" as const,
      action: "delete" as const, changes: { key: longKey, name: "Active ordering tail" } },
    navigation: { name: longKey, status: "deleted" as const } };
  const alone = formatActivityList([short]);
  const together = formatActivityList([short, outlier]);
  expect(together.split("\n")[0]).toBe(alone);
  expect(alone).toContain("APP-1 · archived");
  expect(alone).not.toContain("[archived]");
  expect(together).toContain(`Full project key: ${longKey}`);
  const contentColumn = alone.indexOf("APP-1");
  expect(together.split("\n").find((line) => line.includes("Full project key:"))!.indexOf("Full project key:"))
    .toBe(contentColumn);
  expect(together.split("\n")[1]).not.toContain(longKey);
});
