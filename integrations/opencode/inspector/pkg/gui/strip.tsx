/** @jsxImportSource solid-js */
import type { Accessor } from "solid-js";
import type { BoardSummary } from "./ipc.ts";

import { For, Show } from "solid-js";

/**
 * Local wall-clock time
 * `toISOString` prints UTC, which reads as a wrong time
 */
const clock = (at: number) => {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
};

export function BoardStrip(props: {
  summary: () => BoardSummary | undefined;
  error: () => string;
}) {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "16px",
        height: "30px",
        padding: "0 12px",
        "border-top": "1px solid rgba(127, 127, 127, 0.28)",
        "font-size": "12px",
        "white-space": "nowrap",
        overflow: "hidden",
      }}
    >
      <span style={{ "font-weight": 600 }}>Zinn</span>
      <Show
        when={props.summary()}
        fallback={
          <span
            style={{
              flex: "1",
              "min-width": 0,
              overflow: "hidden",
              "text-overflow": "ellipsis",
              opacity: 0.7,
            }}
            title={props.error()}
          >
            {props.error() ? `no read · ${props.error()}` : "reading…"}
          </span>
        }
      >
        {(summary: Accessor<BoardSummary>) => (
          <>
            <div
              style={{
                display: "flex",
                "align-items": "center",
                gap: "16px",
                flex: 1,
                "min-width": 0,
                overflow: "hidden",
              }}
            >
              <span>
                <b style={{ "font-variant-numeric": "tabular-nums" }}>{summary().total}</b>{" "}
                {summary().total === 1 ? "task" : "tasks"}
              </span>
              <For each={summary().columns}>
                {(column) => (
                  <span style={{ display: "flex", gap: "6px", "align-items": "baseline" }}>
                    <i style={{ "font-style": "normal", opacity: 0.65 }}>{column.name}</i>
                    <b style={{ "font-variant-numeric": "tabular-nums" }}>{column.count}</b>
                  </span>
                )}
              </For>
            </div>
            <span
              style={{
                "flex-shrink": 0,
                "font-variant-numeric": "tabular-nums",
                opacity: 0.65,
              }}
              title={`Last successful read at ${clock(summary().readAt)}`}
            >
              synced {clock(summary().readAt)}
            </span>
          </>
        )}
      </Show>
    </div>
  );
}
