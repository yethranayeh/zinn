import { expect, test } from "bun:test";

import { type PagefindResult, matchedPhrase, sectionUrl } from "../src/components/search/pagefind";

test("the phrase starts at the sentence the match sits in", () => {
  expect(matchedPhrase("task with a <mark>title</mark> and an optional description. <mark>Titles</mark> follow")).toBe(
    "task with a title and an optional description.",
  );
});

test("words before the match are added when the sentence ends too soon", () => {
  expect(matchedPhrase("Saving a <mark>snapshot</mark> first.")).toBe("Saving a snapshot first.");
});

test("a phrase carrying directive syntax is refused", () => {
  expect(matchedPhrase("Edit a task's <mark>title,</mark> description, priority, or labels:")).toBeNull();
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

/** A page in Pagefind's shape: each heading is indexed with a period, followed by its body */
function page(sections: Array<[title: string, body: string]>): PagefindResult {
  let content = "";
  const anchors = sections.map(([title, body]) => {
    const location = content.match(/\S+/g)?.length ?? 0;
    content += `${title}. ${body} `;
    return { element: "h2", id: title.toLowerCase().replaceAll(" ", "-"), text: title, location };
  });
  return { url: "/docs/data/", content, excerpt: "", meta: { title: "Data" }, anchors, sub_results: [] };
}

function sectionOf(result: PagefindResult, title: string, excerpt: string) {
  const anchor = result.anchors.find((candidate) => candidate.text === title)!;
  return { title, url: `/docs/data/#${anchor.id}`, excerpt, locations: [], anchor };
}

test("a section URL carries the phrase when it occurs once, in that section's body", () => {
  const result = page([
    ["Back up", "Save a snapshot before you upgrade."],
    ["Restore", "Load a saved copy."],
  ]);

  expect(sectionUrl(result, sectionOf(result, "Back up", "Save a <mark>snapshot</mark> before you upgrade."))).toBe(
    "/docs/data/#back-up:~:text=Save%20a%20snapshot%20before%20you%20upgrade.",
  );
});

test("a section URL keeps only its anchor when the browser would mark the phrase elsewhere", () => {
  const result = page([
    ["Upgrade core", "In a project that uses core, update it."],
    ["Uninstall", "In a project that uses core, remove it. Then delete the old folder too."],
    ["Restore", "Load a saved copy."],
  ]);

  // The phrase also occurs in an earlier section
  expect(sectionUrl(result, sectionOf(result, "Uninstall", "<mark>In</mark> a project that uses core"))).toBe(
    "/docs/data/#uninstall",
  );
  // The excerpt quotes text from the section before, where the same phrase does get a directive
  const excerpt = "remove it. Then <mark>delete</mark> the old folder too.";
  expect(sectionUrl(result, sectionOf(result, "Restore", excerpt))).toBe("/docs/data/#restore");
  expect(sectionUrl(result, sectionOf(result, "Uninstall", excerpt))).toBe(
    "/docs/data/#uninstall:~:text=Then%20delete%20the%20old%20folder%20too.",
  );
});

test("a section URL keeps only its anchor when the match is in the heading", () => {
  const result = page([["Wait for a busy database", "One command waits for another."]]);

  expect(
    sectionUrl(result, sectionOf(result, "Wait for a busy database", "Wait for a busy <mark>database.</mark> One command")),
  ).toBe("/docs/data/#wait-for-a-busy-database");
});
