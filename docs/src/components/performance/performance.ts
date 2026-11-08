import type { Flow, FlowId, FlowNode } from "./flow-data";

import { flowById } from "./flow-data";
import { hybridTheme } from "./flow-theme";
import { GraphCanvas } from "./graph";

function query<T extends Element>(root: ParentNode, selector: string) {
  return root.querySelector<T>(selector);
}

export function mountPerformance(root: HTMLElement): () => void {
  const canvas = query<HTMLCanvasElement>(root, "[data-flow-canvas]");
  if (!canvas) {
    return () => {};
  }

  const controller = new AbortController();
  const { signal } = controller;
  let flow: Flow = flowById.read;
  let tracing = false;

  const backButton = query<HTMLButtonElement>(root, "[data-inspector-back]");
  const traceButton = query<HTMLButtonElement>(root, "[data-trace]");
  const traceStatus = query<HTMLElement>(root, "[data-trace-status]");
  const flowStates = [...root.querySelectorAll<HTMLElement>("[data-flow-state]")];
  const inspectorStates = [...root.querySelectorAll<HTMLElement>("[data-inspector-state]")];

  const graph = new GraphCanvas(canvas, {
    theme: hybridTheme,
    flow,
    interactive: true,
    linkLabels: true,
    dimOnSelect: true,
    nodeWidth: 210,
    padding: 46,
    onSelect: (node) => renderSelection(node),
    onTraceEnd: () => {
      tracing = false;
      traceButton?.removeAttribute("disabled");
      if (traceButton) {
        traceButton.textContent = "Run";
      }
      if (traceStatus) {
        traceStatus.textContent = "";
      }
    },
  });

  // Below Tailwind's sm breakpoint.
  const belowSmBreakpoint = "(max-width: 639px)";
  if (window.matchMedia(belowSmBreakpoint).matches) {
    graph.focus("cli");
  }

  function activeInspector() {
    return inspectorStates.find((state) => state.dataset.flowState === flow.id) ?? null;
  }

  function renderSelection(node: FlowNode | null) {
    const state = activeInspector();
    if (!state) {
      return;
    }

    const defaultPanel = query<HTMLElement>(state, "[data-inspector-default]");
    const nodePanel = node ? query<HTMLElement>(state, `[data-node-panel="${node.id}"]`) : null;

    if (defaultPanel) {
      defaultPanel.hidden = node !== null;
    }

    for (const panel of state.querySelectorAll<HTMLElement>("[data-node-panel]")) {
      panel.hidden = panel !== nodePanel;
    }

    if (backButton) {
      backButton.hidden = node === null;
    }
  }

  function setFlow(id: FlowId) {
    flow = flowById[id];
    for (const state of flowStates) {
      state.hidden = state.dataset.flowState !== id;
    }

    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-flow]")) {
      button.setAttribute("aria-pressed", String(button.dataset.flow === id));
    }

    tracing = false;
    traceButton?.removeAttribute("disabled");
    if (traceButton) {
      traceButton.textContent = "Run";
    }

    if (traceStatus) {
      traceStatus.textContent = "";
    }

    graph.setFlow(flow);
    canvas?.setAttribute(
      "aria-label",
      `Node graph of the ${flow.name.toLowerCase()} flow. Drag nodes to rearrange them. Use the node list to inspect a node.`,
    );
  }

  const startTrace = () => {
    if (tracing) {
      return;
    }

    tracing = true;
    traceButton?.setAttribute("disabled", "");

    if (traceButton) {
      traceButton.textContent = "Tracing…";
    }

    if (traceStatus) {
      traceStatus.textContent = "Tracing the flow.";
    }

    graph.trace();
  };

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-flow]")) {
    button.addEventListener(
      "click",
      () => {
        const id = button.dataset.flow;
        if (id === "read" || id === "write" || id === "install") {
          setFlow(id);
        }
      },
      { signal },
    );
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-node-select]")) {
    button.addEventListener(
      "click",
      () => {
        const id = button.dataset.nodeSelect;
        if (!id) {
          return;
        }
        graph.select(id);
        graph.focus(id);
      },
      { signal },
    );
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-node-focus]")) {
    button.addEventListener(
      "click",
      () => {
        const id = button.dataset.nodeId;
        if (id) {
          graph.focus(id);
        }
      },
      { signal },
    );
  }

  traceButton?.addEventListener("click", startTrace, { signal });
  query<HTMLButtonElement>(root, "[data-fit]")?.addEventListener("click", () => graph.fit(), {
    signal,
  });
  backButton?.addEventListener("click", () => graph.select(null), { signal });

  for (const state of flowStates) {
    state.hidden = state.dataset.flowState !== flow.id;
  }

  renderSelection(null);

  return () => {
    controller.abort();
    graph.destroy();
  };
}
