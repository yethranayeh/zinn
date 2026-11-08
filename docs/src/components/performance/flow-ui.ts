import type { FlowPort } from "./flow-data";

export const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;

export function renderPorts(
  target: HTMLElement | null,
  ports: Array<FlowPort> | undefined,
  itemClass: string,
) {
  if (!target) {
    return;
  }

  target.replaceChildren();

  if (!ports || ports.length === 0) {
    const item = document.createElement("li");
    item.className = itemClass;
    item.textContent = "None";
    target.append(item);
    return;
  }

  for (const port of ports) {
    const item = document.createElement("li");
    item.className = itemClass;
    item.textContent = port.name;
    target.append(item);
  }
}
