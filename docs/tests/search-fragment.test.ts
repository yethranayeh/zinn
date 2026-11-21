import { expect, test } from "bun:test";

import { matchedPhrase, withTextFragment } from "../src/components/search/pagefind";

test("the phrase starts at the sentence the match sits in", () => {
  expect(matchedPhrase("task with a <mark>title</mark> and an optional description. <mark>Titles</mark> follow")).toBe(
    "task with a title and an optional description.",
  );
});

test("words before the match are added when the sentence ends too soon", () => {
  expect(matchedPhrase("Saving a <mark>snapshot</mark> first.")).toBe("Saving a snapshot first.");
});

test("a phrase carrying directive syntax is refused", () => {
  expect(matchedPhrase("Edit a task’s <mark>title,</mark> description, priority, or labels:")).toBeNull();
  expect(matchedPhrase("$ zinn task create MDR <mark>--title</mark> 'Refine")).toBeNull();
  expect(matchedPhrase("Search covers <mark>titles,</mark> descriptions and comments")).toBeNull();
  expect(matchedPhrase("A <mark>well-known</mark> snapshot is saved locally.")).toBeNull();
  expect(matchedPhrase("Keep <mark>one</mark> & only one store.")).toBeNull();
});

test("a phrase does not run into the next sentence or block", () => {
  expect(matchedPhrase("zinn <mark>backup</mark> The snapshot includes committed changes and can")).toBeNull();
  expect(matchedPhrase("the <mark>backup</mark> is saved. The snapshot includes")).toBe("the backup is saved.");
});

test("an excerpt without a match or with too little context yields no phrase", () => {
  expect(matchedPhrase("no marks in this excerpt")).toBeNull();
  expect(matchedPhrase("<mark>backup</mark>")).toBeNull();
  expect(matchedPhrase("Run <mark>backup</mark>.")).toBeNull();
});

test("a directive is only added to a URL that already carries an anchor", () => {
  const excerpt = "Saving a <mark>snapshot</mark> first.";

  expect(withTextFragment("/docs/data/", excerpt)).toBe("/docs/data/");
  expect(withTextFragment("/docs/data/#", excerpt)).toBe("/docs/data/#");
  expect(withTextFragment("/docs/data/#back-up-the-database", excerpt)).toBe(
    `/docs/data/#back-up-the-database:~:text=${encodeURIComponent("Saving a snapshot first.")}`,
  );
});
