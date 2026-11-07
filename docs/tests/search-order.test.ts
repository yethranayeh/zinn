import { expect, test } from "bun:test";

import { orderResults, sectionsToShow, type PagefindResult } from "../src/components/search/pagefind";

function section(title: string): PagefindResult["sub_results"][number] {
  return {
    title,
    url: `#${title.toLowerCase().replaceAll(" ", "-")}`,
    excerpt: "",
    locations: [0],
    anchor: { id: title.toLowerCase().replaceAll(" ", "-") },
  };
}

function page(title: string, subTitleList: string[] = []): PagefindResult {
  return {
    url: `/${title.toLowerCase().replaceAll(" ", "-")}/`,
    excerpt: "",
    meta: { title },
    sub_results: subTitleList.map(section),
  };
}

const titles = (pages: PagefindResult[]) => pages.map((result) => result.meta.title);

test("a section title naming the query leads its page above a page named only by body matches", () => {
  const pages = orderResults("telemetry", [page("Settings", ["Control local telemetry"]), page("Data and backups", ["Telemetry"])]);
  expect(titles(pages)).toEqual(["Data and backups", "Settings"]);
});

test("a page title naming the query ranks above a section naming it", () => {
  const pages = orderResults("hooks", [page("Integration guides", ["Hooks overview"]), page("Hooks", ["Running hooks"])]);
  expect(titles(pages)).toEqual(["Hooks", "Integration guides"]);
});

test("a multiword query matches a section title with the same words", () => {
  const pages = orderResults("control local telemetry", [page("Data and backups", ["Telemetry"]), page("Settings", ["Control local telemetry"])]);
  expect(titles(pages)).toEqual(["Settings", "Data and backups"]);
});

test("a subset section title promotes its page while keeping the exact-tier page above it", () => {
  const pages = orderResults("telemetry", [page("Settings", ["Control local telemetry"]), page("Privacy", ["Local CLI data"]), page("Data and backups", ["Telemetry"])]);
  expect(titles(pages)).toEqual(["Data and backups", "Settings", "Privacy"]);
});

test("a page title containing the query tokens promotes the page", () => {
  const pages = orderResults("backup", [page("Settings"), page("Data and backups")]);
  expect(titles(pages)).toEqual(["Data and backups", "Settings"]);
});

test("plural titles stem like the query", () => {
  const pages = orderResults("tasks", [page("Labels"), page("Tasks")]);
  expect(titles(pages)).toEqual(["Tasks", "Labels"]);
});

test("dashed flags split into their words", () => {
  const pages = orderResults("--json", [page("Settings"), page("Scripting and JSON output")]);
  expect(titles(pages)).toEqual(["Scripting and JSON output", "Settings"]);
});

test("queries outside the title token budget leave the order alone", () => {
  const pages = [page("Settings", ["Control local telemetry"]), page("Data and backups", ["Telemetry"])];
  const fiveTokens = "telemetry records mode retention limits";
  expect(titles(orderResults(fiveTokens, pages))).toEqual(titles(pages));
  expect(titles(orderResults("--", pages))).toEqual(titles(pages));
});

test("equal tiers keep their original order in both directions", () => {
  const forward = [page("Blame commands A"), page("Blame commands B")];
  const backward = [forward[1], forward[0]];
  expect(titles(orderResults("blame", forward))).toEqual(["Blame commands A", "Blame commands B"]);
  expect(titles(orderResults("blame", backward))).toEqual(["Blame commands B", "Blame commands A"]);
});

test("section titles naming the query lead their page before the match-count order", () => {
  const result = page("Data and backups", ["Retention", "Telemetry", "Clear or turn off records"]);
  expect(sectionsToShow(result, "telemetry").map((shown) => shown.title)).toEqual(["Telemetry", "Retention", "Clear or turn off records"]);
});

test("equally named sections follow the match-count order", () => {
  // Both titles contain the query token, so the section with more matches leads regardless of document order
  const result = page("Data and backups", ["Record fields", "Clear or turn off records"]);
  result.sub_results[0].locations = [0];
  result.sub_results[1].locations = [0, 1];
  expect(sectionsToShow(result, "record").map((shown) => shown.title)).toEqual(["Clear or turn off records", "Record fields"]);
});

test("sections without the query keep the match-count order", () => {
  const result = page("Data and backups", ["Retention", "Telemetry"]);
  result.sub_results[0].locations = [0];
  result.sub_results[1].locations = [0, 1];
  expect(sectionsToShow(result, "maxAgeDays").map((shown) => shown.title)).toEqual(["Telemetry", "Retention"]);
});
