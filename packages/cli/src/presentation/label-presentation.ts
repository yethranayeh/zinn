import type { Label } from "@zinn-dev/core";
import type { PresentedLabel } from "../result-schemas.js";
import type { RowCell } from "./row-layout.js";

import { labelColorSchema } from "@zinn-dev/core";

import { isColorEnabled } from "./color.js";
import { formatDescriptionPreview } from "./description-presentation.js";
import { formatRows } from "./row-layout.js";

export function presentLabel(labelMatch: Label): PresentedLabel {
  return {
    id: labelMatch.id,
    name: labelMatch.name,
    color: labelMatch.color,
    description: labelMatch.description,
  };
}

export function labelNameCell(name: string, color: string): RowCell {
  const style = labelColorSchema.options.find((labelColor) => labelColor === color);
  return { text: name, style };
}

export function formatLabelList(
  presentedLabels: Array<PresentedLabel>,
  options: { showsDescriptionPreview?: boolean } = {},
) {
  return formatRows(
    presentedLabels.map((presented) => {
      const description =
        options.showsDescriptionPreview && presented.description != null
          ? formatDescriptionPreview(presented.description, { firstLineOnly: true })
          : presented.description;
      const descriptionCells: Array<RowCell> = description == null ? [] : [{ text: description }];

      if (isColorEnabled()) {
        return [labelNameCell(presented.name, presented.color), ...descriptionCells];
      }

      return [{ text: presented.name }, { text: presented.color }, ...descriptionCells];
    }),
  );
}
