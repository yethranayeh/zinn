import { expect, test } from "bun:test";
import { CATEGORY_LOOK, isClosed } from "../integrations/claude-code/zinn/lib/columns.ts";
import { CLOSED_COLUMN_CATEGORIES, columnCategorySchema } from "../packages/core/src/schemas/column.ts";

// The zinn Claude Code plugin loads without a build step, so it keeps its own copy of core's column categories.

test("the Claude Code plugin marks every column category core defines, and no other", () => {
  expect(Object.keys(CATEGORY_LOOK).sort()).toEqual([...columnCategorySchema.options].sort());
});

test("the Claude Code plugin closes the same categories as core", () => {
  const closed = columnCategorySchema.options.filter((category) =>
    isClosed({ category, isFirst: false, isLast: false }),
  );
  expect(closed.sort()).toEqual([...CLOSED_COLUMN_CATEGORIES].sort());
});
