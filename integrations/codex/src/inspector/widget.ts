import type { RecentRead } from "./references";
import type { TaskRead } from "./task-reader";
import type { TaskColumnsRead, TaskMoveRead } from "./task-actions";
import type { PresentedTaskDetail } from "../../../../packages/cli/src/result-schemas.js";

import { App } from "@modelcontextprotocol/ext-apps";
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

let selected: string | undefined;
let selectionVersion = 0;
let connected = false;
let disposed = false;
let recentLoading = false;
let recentPending = false;
let recentVersion = 0;
let referenceSignature = "";
let moving = false;
let polling: ReturnType<typeof setInterval> | undefined;

function markSelection() {
  for (const button of recentList.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-current", String(button.dataset.key === selected));
  }
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
    warnings.push("Observer capacity reached; newer references may be absent.");
  }

  recentStatus.textContent = [messages[value.kind], ...warnings].join(" ");
  const signature = JSON.stringify([value.kind === "ready", value.references]);
  if (signature === referenceSignature) {
    return;
  }

  referenceSignature = signature;
  recentList.replaceChildren(
    ...value.references.map((reference) => {
      const task = reference.task;
      const missing = value.kind === "ready" && task === undefined;
      const state = task
        ? `${task.title} · ${task.status === "Archived" ? "Archived" : task.column}`
        : missing
          ? "Not in this store"
          : "Cannot verify";
      const button = text(
        "button",
        `${missing ? "⚠ " : ""}${reference.key} · ${state}`,
        missing ? "reference warning" : "reference",
      ) as HTMLButtonElement;
      button.type = "button";
      button.dataset.key = reference.key;
      button.addEventListener("click", () => {
        void openTask(reference.key);
      });
      return button;
    }),
  );

  markSelection();
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
  const block = text("section", "", "section");
  block.append(text("h2", title), ...nodes);
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
      if (selected === key && document.activeElement === document.body) {
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

function renderMove(task: PresentedTaskDetail) {
  if (task.status === "Archived") {
    return;
  }

  const version = selectionVersion;
  const form = document.createElement("form");
  form.className = "move-controls";
  const label = document.createElement("label");
  label.textContent = "Destination";
  const destination = document.createElement("select");
  destination.setAttribute("aria-label", `Destination for ${task.key}`);
  destination.disabled = true;
  label.append(destination);
  const button = text("button", "Move task") as HTMLButtonElement;
  button.type = "submit";
  button.disabled = true;
  const feedback = text("p", "Loading columns…", "muted");
  feedback.setAttribute("role", "status");
  form.append(label, button, feedback);
  detail.append(form);

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
  const state = task.status === "Archived" ? "Archived" : `${task.column} · ${task.status}`;
  detail.replaceChildren(
    text("div", task.key, "meta"),
    text("h1", task.title),
    text("p", `${state} · Priority: ${task.priority ?? "none"}`, "meta"),
  );

  if (task.labels.length) {
    detail.append(text("p", `Labels: ${task.labels.join(", ")}`, "meta"));
  }

  renderMove(task);
  const description = text("div", task.description ?? "No description.", "description");
  detail.append(description);
  if (task.relations?.length) {
    const nodes = task.relations.map((relation) => {
      const direction =
        relation.direction === "incoming" ? "←" : relation.direction === "outgoing" ? "→" : "↔";
      const button = text(
        "button",
        `${direction} ${relation.type} · ${relation.task.key} · ${relation.task.title} · ${relation.task.status === "Archived" ? "Archived" : relation.task.column}`,
        "relation",
      ) as HTMLButtonElement;
      button.type = "button";
      button.addEventListener("click", () => openTask(relation.task.key));
      return button;
    });
    detail.append(section("Relations", nodes));
  }

  if (task.comments?.length) {
    detail.append(
      section(
        "Comments",
        task.comments.map((comment) => text("div", `${comment.key}\n${comment.text}`, "comment")),
      ),
    );
  }

  detail.append(text("p", `Read at ${new Date(fetchedAt).toLocaleTimeString()}`, "meta"));
}

function render(value: TaskRead) {
  store.textContent = `Store: ${value.store}`;
  status.textContent = "";

  if (value.kind === "ready" && value.task && value.fetchedAt) {
    selected = value.task.key;
    keyInput.value = selected;
    renderTask(value.task, value.fetchedAt);
  } else if (value.kind === "idle") {
    detail.replaceChildren(text("p", "Enter a task key to read its details.", "muted"));
  } else {
    detail.replaceChildren(
      text(
        "h1",
        value.kind === "missing"
          ? `${value.key} is not in this store`
          : value.kind === "invalid"
            ? "Enter a task key"
            : `Could not open ${value.key ?? "task"}`,
        "error",
      ),
      text("p", value.error ?? "Task read failed."),
    );
  }
}
async function openTask(rawKey?: string) {
  if (!connected) {
    return;
  }

  const key = rawKey?.trim().toUpperCase();
  selected = key;
  markSelection();
  if (key !== undefined) {
    keyInput.value = key;
  }

  const version = ++selectionVersion;
  refresh.disabled = true;
  detail.replaceChildren(text("p", key ? `Loading ${key}…` : "Connecting…", "muted"));
  try {
    const result = await app.callServerTool({
      name: "inspect_task",
      arguments: key === undefined ? {} : { key },
    });

    if (version !== selectionVersion) {
      return;
    }

    if (result.isError || !result.structuredContent) {
      throw new Error("The native host could not read this task.");
    }

    render(result.structuredContent as TaskRead);
  } catch (error) {
    if (version === selectionVersion) {
      detail.replaceChildren(text("h1", "Task read failed", "error"), text("p", String(error)));
    }
  } finally {
    if (version === selectionVersion) {
      refresh.disabled = false;
    }
  }
}

// The thread opener's initial tool result must not overwrite an explicit lookup.
app.ontoolresult = (result) => {
  if (selectionVersion === 0 && result.structuredContent) {
    render(result.structuredContent as TaskRead);
  }
};

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
  connected = true;
  lookup.querySelector<HTMLButtonElement>("button")!.disabled = false;
  await openTask();
  startPolling();
} catch (error) {
  status.textContent = `Native bridge did not connect: ${String(error)}`;
}
