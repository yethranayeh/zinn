import type { RecentRead } from "./references";
import type { TaskRead } from "./task-reader";
import type { TaskColumnsRead, TaskMoveRead } from "./task-actions";
import type { PresentedTaskDetail } from "../../../../packages/cli/src/result-schemas.js";

import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { INSPECTOR_VERSION, RECENT_POLL_MS } from "../runtime";

const app = new App({ name: "Zinn task inspector", version: INSPECTOR_VERSION });
const detail = document.querySelector<HTMLElement>("#detail")!;
const keyInput = document.querySelector<HTMLInputElement>("#key")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const lookup = document.querySelector<HTMLFormElement>("#lookup")!;
const status = document.querySelector<HTMLElement>("#status")!;
const store = document.querySelector<HTMLElement>("#store")!;
const recentList = document.querySelector<HTMLElement>("#recent-list")!;
const recentStatus = document.querySelector<HTMLElement>("#recent-status")!;
const recentCount = document.querySelector<HTMLElement>("#recent-count")!;
const referencesToggle = document.querySelector<HTMLButtonElement>("#references-toggle")!;
// Keep the selected task near the lookup even when a chat has many references.
const COLLAPSED_REFERENCE_COUNT = 3;

let selected: string | undefined;
let selectionVersion = 0;
let userNavigated = false;
let connected = false;
let disposed = false;
let recentLoading = false;
let recentPending = false;
let recentVersion = 0;
let referenceSignature = "";
let referencesExpanded = false;
let moving = false;
let polling: ReturnType<typeof setInterval> | undefined;

function markSelection() {
  for (const button of recentList.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-current", String(button.dataset.key === selected));
  }
}

function template<T extends HTMLElement>(id: string): T {
  const source = document.querySelector<HTMLTemplateElement>(`#${id}`)!;
  return (source.content.cloneNode(true) as DocumentFragment).firstElementChild as T;
}

function showReferences() {
  const buttons = [...recentList.querySelectorAll<HTMLButtonElement>("button")];
  buttons.forEach((button, index) => {
    button.hidden = !referencesExpanded && index >= COLLAPSED_REFERENCE_COUNT;
  });
  referencesToggle.hidden = buttons.length <= COLLAPSED_REFERENCE_COUNT;
  referencesToggle.setAttribute("aria-expanded", String(referencesExpanded));
  referencesToggle.textContent = referencesExpanded
    ? "Show fewer references"
    : `Show all ${buttons.length} references`;
}

function renderRecent(value: RecentRead) {
  const messages: Record<RecentRead["kind"], string> = {
    ready: value.references.length
      ? "Observed CLI calls, dispatches and completed replies."
      : "No observed task references in this chat yet.",
    absent_metadata: "The host did not identify this chat. Manual lookup is available.",
    conflicting_metadata: "The host supplied conflicting chat IDs. Manual lookup is available.",
    no_feed: "No observer feed is available for this chat yet.",
    error: value.error ?? "Could not read recent references.",
  };

  const warnings = [];
  if (value.replyFailures) {
    warnings.push(
      `${value.replyFailures} completed replies could not be checked against this store.`,
    );
  }

  if (value.incomplete) {
    warnings.push(`${value.incomplete} incomplete observer records.`);
  }

  if (value.atCapacity) {
    warnings.push("Observer capacity reached. Newer references may be absent.");
  }

  recentStatus.textContent = [messages[value.kind], ...warnings].join(" ");
  recentCount.textContent = value.references.length ? String(value.references.length) : "";
  const signature = JSON.stringify([value.kind === "ready", value.references]);
  if (signature === referenceSignature) {
    return;
  }

  referenceSignature = signature;
  const focused = document.activeElement as HTMLElement | null;
  const hadReferenceFocus =
    focused !== null && (recentList.contains(focused) || focused === referencesToggle);
  const existing = new Map(
    [...recentList.querySelectorAll<HTMLButtonElement>("button")].map((button) => [
      button.dataset.key!,
      button,
    ]),
  );
  const retained = new Set<string>();
  value.references.forEach((reference, index) => {
    const task = reference.task;
    const missing = value.kind === "ready" && task === undefined;
    const state = task
      ? task.status === "Archived"
        ? "Archived"
        : task.column
      : missing
        ? "Not in this store"
        : "Cannot verify";
    let button = existing.get(reference.key);
    if (!button) {
      button = template<HTMLButtonElement>("reference-template");
      button.dataset.key = reference.key;
      button.addEventListener("click", () => {
        void openTask(reference.key, { focusHeading: true });
      });
    }
    button.querySelector<HTMLElement>("[data-key]")!.textContent = reference.key;
    button.querySelector<HTMLElement>("[data-title]")!.textContent = task?.title ?? state;
    const metadata = button.querySelector<HTMLElement>("[data-meta]")!;
    metadata.textContent = state;
    metadata.hidden = task === undefined;
    button.title = task?.title ?? state;
    retained.add(reference.key);
    if (recentList.children[index] !== button) {
      recentList.insertBefore(button, recentList.children[index] ?? null);
    }
  });
  for (const [key, button] of existing) {
    if (!retained.has(key)) {
      button.remove();
    }
  }
  const focusedBeyondCollapsedList =
    hadReferenceFocus &&
    focused.isConnected &&
    [...recentList.children].indexOf(focused) >= COLLAPSED_REFERENCE_COUNT;
  if (focusedBeyondCollapsedList) {
    referencesExpanded = true;
  }
  showReferences();
  markSelection();
  if (hadReferenceFocus && document.hasFocus() && document.activeElement === document.body) {
    if (focused.isConnected && !focused.hidden) {
      focused.focus({ preventScroll: true });
    } else {
      recentStatus.focus({ preventScroll: true });
    }
  }
}

async function refreshRecent() {
  if (!connected || disposed || document.hidden) {
    return;
  }

  if (recentLoading) {
    recentPending = true;
    return;
  }

  recentLoading = true;
  const version = recentVersion;
  try {
    const result = await app.callServerTool({ name: "recent_tasks", arguments: {} });
    if (disposed || document.hidden || version !== recentVersion) {
      return;
    }

    if (result.isError || !result.structuredContent) {
      throw new Error("The native host could not read recent references.");
    }

    renderRecent(result.structuredContent as RecentRead);
  } catch (error) {
    if (!disposed && !document.hidden && version === recentVersion) {
      renderRecent({
        kind: "error",
        store: "",
        references: [],
        incomplete: 0,
        atCapacity: false,
        error: String(error),
      });
    }
  } finally {
    recentLoading = false;
    if (recentPending) {
      recentPending = false;
      void refreshRecent();
    }
  }
}

function stopPolling() {
  recentVersion++;
  clearInterval(polling);
  polling = undefined;
}

function startPolling() {
  if (!connected || disposed || document.hidden) {
    return;
  }
  stopPolling();
  void refreshRecent();
  polling = setInterval(() => {
    void refreshRecent();
  }, RECENT_POLL_MS);
}

function text(tag: string, content: string, className?: string) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) {
    node.className = className;
  }
  return node;
}

function section(title: string, nodes: HTMLElement[]) {
  const block = text("section", "", "flex min-w-0 flex-col gap-2");
  block.append(text("h2", title, "text-xs font-semibold"), ...nodes);
  return block;
}

async function moveTask(key: string, column: string) {
  if (moving || disposed) {
    return;
  }

  moving = true;
  for (const control of detail.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
    ".move-controls button, .move-controls select",
  )) {
    control.disabled = true;
  }
  status.textContent = `Moving ${key} to ${column}…`;
  let message: string;
  try {
    const response = await app.callServerTool({ name: "move_task", arguments: { key, column } });
    if (response.isError || !response.structuredContent) {
      throw new Error(
        "The host did not confirm the move. Check the current task before trying again.",
      );
    }

    const result = response.structuredContent as TaskMoveRead;
    message =
      result.kind === "ready"
        ? result.changed
          ? `Moved ${key} to ${column}.`
          : `${key} is already in ${column}.`
        : (result.error ?? `Could not move ${key}.`);
  } catch (error) {
    message = String(error);
  } finally {
    moving = false;
  }

  if (!disposed) {
    const selectedAfterMove = selected;
    await openTask(selectedAfterMove);
    if (!disposed && selected === selectedAfterMove) {
      status.textContent = message;
      if (selected === key && document.hasFocus() && document.activeElement === document.body) {
        const heading = detail.querySelector<HTMLElement>("h1");
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }
    }
  }
  void refreshRecent();
}

function renderMove(task: PresentedTaskDetail, container: HTMLElement) {
  if (task.status === "Archived") {
    container.remove();
    return;
  }

  const version = selectionVersion;
  const form = template<HTMLFormElement>("move-template");
  const destination = form.querySelector<HTMLSelectElement>("select")!;
  destination.setAttribute("aria-label", `Destination for ${task.key}`);
  const button = form.querySelector<HTMLButtonElement>("button")!;
  const feedback = form.querySelector<HTMLElement>("[data-feedback]")!;
  container.append(form);

  function updateDestination() {
    button.textContent = `Move to ${destination.value}`;
    button.disabled = moving || destination.value === task.column;
  }
  destination.addEventListener("change", updateDestination);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!button.disabled) {
      void moveTask(task.key, destination.value);
    }
  });

  void (async () => {
    try {
      const response = await app.callServerTool({
        name: "task_columns",
        arguments: { key: task.key },
      });
      if (disposed || version !== selectionVersion || !form.isConnected) {
        return;
      }
      if (response.isError || !response.structuredContent) {
        throw new Error("Could not load destination columns. Refresh to try again.");
      }
      const result = response.structuredContent as TaskColumnsRead;
      if (result.kind !== "ready" || !result.columns?.length) {
        throw new Error(result.error ?? "No destination columns are available.");
      }
      for (const column of result.columns) {
        const option = document.createElement("option");
        option.value = column.name;
        option.textContent = column.name;
        destination.append(option);
      }
      // Older CLIs return no category, so their panels start on the current column.
      destination.value =
        result.columns.find((column) => column.category === "done")?.name ?? task.column;
      destination.disabled = moving;
      feedback.textContent = `Move ${task.key} within its project.`;
      updateDestination();
    } catch (error) {
      if (!disposed && version === selectionVersion && form.isConnected) {
        feedback.textContent = String(error);
      }
    }
  })();
}

function renderTask(task: PresentedTaskDetail, fetchedAt: string) {
  const article = template<HTMLElement>("task-template");
  article.querySelector<HTMLElement>("[data-task-key]")!.textContent = task.key;
  article.querySelector<HTMLElement>("h1")!.textContent = task.title;
  article.querySelector<HTMLElement>("[data-column]")!.textContent = task.column;
  article.querySelector<HTMLElement>("[data-status]")!.textContent = task.status;
  article.querySelector<HTMLElement>("[data-priority]")!.textContent = task.priority ?? "none";
  const labels = article.querySelector<HTMLElement>("[data-labels]")!;
  labels.textContent = task.labels.length ? `Labels: ${task.labels.join(", ")}` : "";
  labels.hidden = task.labels.length === 0;
  article.querySelector<HTMLElement>("[data-description]")!.textContent =
    task.description ?? "No description.";
  article.querySelector<HTMLElement>("[data-read-time]")!.textContent =
    `Read at ${new Date(fetchedAt).toLocaleTimeString()}`;
  const sections = article.querySelector<HTMLElement>("[data-sections]")!;
  detail.replaceChildren(article);
  renderMove(task, article.querySelector<HTMLElement>("[data-move]")!);
  if (task.relations?.length) {
    const nodes = task.relations.map((relation) => {
      const direction =
        relation.direction === "incoming" ? "←" : relation.direction === "outgoing" ? "→" : "↔";
      const button = template<HTMLButtonElement>("relation-template");
      button.querySelector<HTMLElement>("[data-key]")!.textContent = relation.task.key;
      button.querySelector<HTMLElement>("[data-title]")!.textContent = relation.task.title;
      button.querySelector<HTMLElement>("[data-meta]")!.textContent =
        `${direction} ${relation.type} · ${relation.task.status === "Archived" ? "Archived" : relation.task.column}`;
      button.addEventListener(
        "click",
        () => void openTask(relation.task.key, { focusHeading: true }),
      );
      return button;
    });
    sections.append(section("Relations", nodes));
  }

  if (task.comments?.length) {
    sections.append(
      section(
        "Comments",
        task.comments.map((comment) => {
          const block = text("div", "", "flex min-w-0 flex-col gap-2");
          block.append(
            template<HTMLElement>("separator-template"),
            text("p", comment.key, "text-xs font-medium wrap-anywhere"),
            text("div", comment.text, "whitespace-pre-wrap wrap-anywhere"),
          );
          return block;
        }),
      ),
    );
  }

  sections.hidden = sections.childElementCount === 0;
}

function renderState(heading: string, message: string, action?: "lookup" | "retry") {
  const block = template<HTMLElement>("state-template");
  block.querySelector<HTMLElement>("h1")!.textContent = heading;
  block.querySelector<HTMLElement>("[data-message]")!.textContent = message;
  const retry = block.querySelector<HTMLButtonElement>("[data-retry]")!;
  retry.hidden = action === undefined;
  retry.textContent = action === "lookup" ? "Enter a task key" : "Try again";
  retry.addEventListener("click", () => {
    if (action === "lookup") {
      keyInput.focus();
    } else {
      void openTask(selected, { focusHeading: true });
    }
  });
  detail.replaceChildren(block);
}

function render(value: TaskRead) {
  store.textContent = `Store: ${value.store}`;
  status.textContent = "";

  if (value.kind === "ready" && value.task && value.fetchedAt) {
    selected = value.task.key;
    renderTask(value.task, value.fetchedAt);
    status.textContent = `Opened ${selected}.`;
  } else if (value.kind === "idle") {
    renderState("No task selected", "Enter a task key or choose an observed reference.", "lookup");
  } else {
    renderState(
      value.kind === "missing"
        ? `${value.key} is not in this store`
        : value.kind === "invalid"
          ? "Enter a task key"
          : `Could not open ${value.key ?? "task"}`,
      value.error ?? "Task read failed.",
      value.kind === "invalid" ? "lookup" : "retry",
    );
    status.textContent =
      value.kind === "missing" ? `${value.key} is missing from this store.` : "Task read failed.";
  }
  keyInput.setAttribute("aria-invalid", String(value.kind === "invalid"));
  detail.setAttribute("aria-busy", "false");
  markSelection();
}
async function openTask(
  rawKey?: string,
  options: { focusHeading?: boolean; automatic?: boolean } = {},
) {
  if (!connected) {
    return;
  }
  if (!options.automatic) {
    userNavigated = true;
  }

  const key = rawKey?.trim().toUpperCase();
  selected = key;
  markSelection();
  if (key !== undefined) {
    keyInput.value = key;
  }

  const version = ++selectionVersion;
  const initiatingControl = document.activeElement;
  refresh.disabled = true;
  detail.setAttribute("aria-busy", "true");
  status.textContent = key ? `Loading ${key}…` : "Reading selected store…";
  renderState(key ? `Loading ${key}…` : "Loading…", "Reading from the selected store.");
  try {
    const result = await app.callServerTool({
      name: "inspect_task",
      arguments: key === undefined ? {} : { key },
    });

    if (disposed || version !== selectionVersion) {
      return;
    }

    if (result.isError || !result.structuredContent) {
      throw new Error("The native host could not read this task.");
    }

    render(result.structuredContent as TaskRead);
  } catch (error) {
    if (!disposed && version === selectionVersion) {
      renderState(key ? `Could not open ${key}` : "Task read failed", String(error), "retry");
      status.textContent = "Task read failed.";
    }
  } finally {
    if (!disposed && version === selectionVersion) {
      refresh.disabled = false;
      detail.setAttribute("aria-busy", "false");
      const focusStayedOnNavigation =
        document.hasFocus() &&
        (document.activeElement === initiatingControl || document.activeElement === document.body);
      if (options.focusHeading && focusStayedOnNavigation) {
        detail.querySelector<HTMLElement>("h1")?.focus();
      }
    }
  }
}

// The thread opener's initial tool result must not overwrite an explicit lookup.
app.ontoolresult = (result) => {
  if (!disposed && !userNavigated && result.structuredContent) {
    selectionVersion++;
    const value = result.structuredContent as TaskRead;
    selected = value.task?.key ?? value.key;
    render(value);
    if (keyInput.value === "" && selected !== undefined) {
      keyInput.value = selected;
    }
    refresh.disabled = !connected;
  }
};

function applyContext(context: ReturnType<typeof app.getHostContext>) {
  if (context?.theme) {
    applyDocumentTheme(context.theme);
  }
  if (context?.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
}
app.onhostcontextchanged = applyContext;

referencesToggle.addEventListener("click", () => {
  referencesExpanded = !referencesExpanded;
  showReferences();
});

lookup.addEventListener("submit", (event) => {
  event.preventDefault();
  void openTask(keyInput.value);
});

refresh.addEventListener("click", () => {
  void openTask(selected);
  void refreshRecent();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
  }
});

app.onteardown = async () => {
  disposed = true;
  stopPolling();
  return {};
};

window.addEventListener("pagehide", () => {
  disposed = true;
  stopPolling();
});

try {
  await app.connect();
  applyContext(app.getHostContext());
  connected = true;
  lookup.querySelector<HTMLButtonElement>("button")!.disabled = false;
  await openTask(selected, { automatic: true });
  startPolling();
} catch (error) {
  status.textContent = `Native bridge did not connect: ${String(error)}`;
  detail.setAttribute("aria-busy", "false");
  renderState(
    "Native connection unavailable",
    "Close and reopen this panel to connect again. Your tasks are read through the native host.",
  );
}
