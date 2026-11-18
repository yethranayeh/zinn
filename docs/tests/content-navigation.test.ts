import { expect, test } from "bun:test";
import { getBreadcrumbItems } from "../src/config/routes";

const pages = [
  { id: "manual", data: { title: "Product manual", navTitle: "Manual" } },
  { id: "manual/library", data: { title: "Library" } },
  { id: "manual/library/history", data: { title: "Recorded changes", navTitle: "History" } },
];

test("breadcrumbs use the labels of every ancestor page", () => {
  expect(getBreadcrumbItems("/manual/library/history/", "Recorded changes", pages)).toEqual([
    { name: "Manual", path: "/manual/" },
    { name: "Library", path: "/manual/library/" },
    { name: "History", path: "/manual/library/history/" },
  ]);
});

test("a page without a separate navigation label uses its title", () => {
  expect(getBreadcrumbItems("/manual/library/", "Library", pages)).toEqual([
    { name: "Manual", path: "/manual/" },
    { name: "Library", path: "/manual/library/" },
  ]);
});

test("a page outside the content collection keeps its title and known section", () => {
  expect(getBreadcrumbItems("/integrations/editor/theme/", "Editor theme", pages)).toEqual([
    { name: "Integrations", path: "/integrations/" },
    { name: "Editor theme", path: "/integrations/editor/theme/" },
  ]);
});

test("root pages have no breadcrumb trail", () => {
  expect(getBreadcrumbItems("/manual/", "Product manual", pages)).toEqual([]);
  expect(getBreadcrumbItems("/", "Home", pages)).toEqual([]);
});
