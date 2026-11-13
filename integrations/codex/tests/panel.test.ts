import { expect, test } from "bun:test";
import { buildPanel } from "../build-panel";

test("compiled panel contains its styles, controls and one portable browser module", async () => {
  const { html } = await buildPanel();
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  new Bun.Transpiler({ loader: "js", target: "browser" }).transformSync(scripts[0]![1]!);
  expect(html).not.toMatch(/<(?:script|link|img|source)\b[^>]*(?:src|href)=/);
  const externalCss = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].flatMap(
    ([, css]) => [...css!.matchAll(/url\(\s*["']?([^)'"\s]+)/g)]
      .map(([, url]) => url!)
      .filter((url) => !url.startsWith("data:") && !url.startsWith("#")),
  );
  expect(externalCss).toEqual([]);
  expect(html).not.toContain("/Users/");
  expect(html).not.toContain("/fonts/");
  expect(html).not.toContain("Bun.");

  const templates = new Map(
    [...html.matchAll(/<template id="([^"]+)"[^>]*>([\s\S]*?)<\/template>/g)].map(
      ([, name, content]) => [name!, content!],
    ),
  );
  for (const name of ["reference-template", "relation-template", "move-template", "state-template"]) {
    expect(templates.get(name)).toMatch(/<button\b/);
  }
  expect(templates.get("separator-template")).toContain('aria-hidden="true"');
  expect(templates.get("task-template")).toContain("data-description");
  expect(html).toContain("--color-text-primary");
  expect(html).toContain("--font-sans");
}, 30_000);
