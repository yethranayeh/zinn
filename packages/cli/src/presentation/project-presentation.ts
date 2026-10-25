import type { PresentedProject, PresentedProjectListEntry } from "../result-schemas.js";

import { formatDescriptionPreview } from "./description-presentation.js";
import { formatCellSeparator, formatRows } from "./row-layout.js";

type ProjectRow = PresentedProject & { taskCounts?: PresentedProjectListEntry["taskCounts"] };
type ProjectRowOptions = { showsDescriptionPreview?: boolean; showsTaskCounts?: boolean };

export function presentProject(projectMatch: PresentedProject): PresentedProject {
  return {
    id: projectMatch.id,
    key: projectMatch.key,
    name: projectMatch.name,
    description: projectMatch.description,
  };
}

export function formatProjectList(
  presentedProjects: Array<ProjectRow>,
  { showsDescriptionPreview = true, showsTaskCounts = false }: ProjectRowOptions = {},
) {
  return formatRows(
    presentedProjects.map((presented) => {
      const descriptionPreview = showsDescriptionPreview
        ? formatDescriptionPreview(presented.description)
        : "";
      const description =
        descriptionPreview.length > 0 ? `${formatCellSeparator()}${descriptionPreview}` : "";

      if (showsTaskCounts && presented.taskCounts != null) {
        return [
          { text: presented.key },
          { text: presented.name },
          { text: `${presented.taskCounts.active} active` },
          { text: `${presented.taskCounts.archived} archived${description}` },
        ];
      }

      return [{ text: presented.key }, { text: `${presented.name}${description}` }];
    }),
  );
}
