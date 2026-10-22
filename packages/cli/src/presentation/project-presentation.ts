import type { PresentedProject } from "../result-schemas.js";

import { formatDescriptionPreview } from "./description-presentation.js";
import { formatCellSeparator, formatRows } from "./row-layout.js";

type ProjectRowOptions = { showsDescriptionPreview?: boolean };

export function presentProject(projectMatch: PresentedProject): PresentedProject {
  return { key: projectMatch.key, name: projectMatch.name, description: projectMatch.description };
}

export function formatProjectList(
  presentedProjects: Array<PresentedProject>,
  { showsDescriptionPreview = true }: ProjectRowOptions = {},
) {
  return formatRows(
    presentedProjects.map((presented) => {
      const descriptionPreview = showsDescriptionPreview
        ? formatDescriptionPreview(presented.description)
        : "";
      const description =
        descriptionPreview.length > 0 ? `${formatCellSeparator()}${descriptionPreview}` : "";

      return [{ text: presented.key }, { text: `${presented.name}${description}` }];
    }),
  );
}
