import type { DoctorCheck, DoctorStatus } from "@zinn-dev/core";
import type { PresentedDoctor } from "../result-schemas.js";
import type { StyleFormat } from "./color.js";

import { styleOutputText } from "./color.js";

const STATUS_STYLES: Record<DoctorStatus, StyleFormat> = {
  ok: "green",
  warning: "yellow",
  problem: "red",
};
const STATUS_WIDTH = Math.max(...Object.keys(STATUS_STYLES).map((status) => status.length));
const REMEDY_INDENT = " ".repeat(STATUS_WIDTH + 1);

export function presentDoctor(
  checks: ReadonlyArray<DoctorCheck>,
  agentSkill: DoctorCheck<"agent_skill">,
): PresentedDoctor {
  const presented = [...checks, agentSkill];

  return {
    ok: presented.every((check) => check.status === "ok"),
    checks: presented,
  };
}

export function formatDoctor(report: PresentedDoctor): string {
  return report.checks
    .flatMap(({ status, message, remedy }) => {
      const label = styleOutputText(STATUS_STYLES[status], status.padEnd(STATUS_WIDTH));
      const line = `${label} ${message}`;

      return remedy === null ? [line] : [line, `${REMEDY_INDENT}${remedy}`];
    })
    .join("\n");
}
