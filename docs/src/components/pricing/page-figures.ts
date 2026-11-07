export interface Stop {
  tasks: number;
  databaseBytes: number;
  seconds: number;
  memoryBytes: number;
  outputBytes: number;
  jsonOutputBytes: number;
}
export interface Figures {
  packages: Array<{ download: number; zinn: boolean }>;
  gross: number;
  net: number;
  netShare: number;
  stops: Array<Stop>;
  story: Array<{ name: string; figure: string; text: string; fill: number }>;
  commands: Array<{ command: string; output: number }>;
}

const root = document.querySelector<HTMLElement>("[data-figures]");
if (!root?.dataset.figures) {
  throw new Error("pricing figures are missing");
}
export const figures = JSON.parse(root.dataset.figures) as Figures;
