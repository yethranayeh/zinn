/** @jsxImportSource solid-js */
import type { Accessor, JSX } from "solid-js";
import type { BoardSummary } from "./ipc.ts";

import { For, Show } from "solid-js";

import { ZINN_WORDMARK } from "./wordmark.ts";

/**
 * Local wall-clock time
 * `toISOString` prints UTC, which reads as a wrong time
 */
const clock = (at: number) => {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
};

const STRIP_MARK = 64;
const STRIP_TOTAL = 96;
const STRIP_FRESH = 104;
const STRIP_SPACER = 16;
const STRIP_HATCH_INK = "10%";
const STRIP_RULE = "color-mix(in srgb, currentColor 17%, transparent)";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Fixed widths keyed by the column name. Column order comes from the read. */
const STRIP_COLUMN: Record<string, number> = {
  TODO: 74,
  "In Progress": 114,
  Review: 86,
  Backlog: 104,
  Done: 78,
};
const stripColumnWidth = (column: string) =>
  STRIP_COLUMN[column] ?? Math.max(86, 40 + column.length * 8);

const STRIP_LABEL: JSX.CSSProperties = {
  "font-size": "9.5px",
  "letter-spacing": "0.085em",
  "text-transform": "uppercase",
  opacity: 0.6,
  "white-space": "nowrap",
};
const STRIP_CELL: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "10px",
  padding: "0 9px",
  "border-right": `1px solid ${STRIP_RULE}`,
  "white-space": "nowrap",
  "min-width": "0",
};

/**
 * The elastic cell between the counts and the stamp. It is hatched rather than
 * blank so a missing render and an intentional seam do not look the same.
 */
const HATCH_CSS = `
[data-zinn-hatch] {
  background-image: repeating-linear-gradient(
    var(--zinn-hatch-angle, 315deg),
    color-mix(in srgb, currentColor var(--zinn-hatch-ink, 10%), transparent) 0 var(--zinn-hatch-line, 1px),
    transparent var(--zinn-hatch-line, 1px) var(--zinn-hatch-pitch, 8px)
  );
}
`;

const STRIP_CSS = `
[data-zinn-word] { transition: none; }
[data-zinn-word]:hover { opacity: 0.7; }
[data-zinn-word]:active { opacity: 1; }
[data-zinn-word]:focus-visible { outline: 1px solid currentColor; outline-offset: 2px; }
`;

const countInk = (category: string) => {
  if (category === "done") {
    return { color: "#22c55e", opacity: 1 };
  }
  if (category === "backlog" || category === "cancelled") {
    return { opacity: 0.55 };
  }
  return { opacity: 1 };
};

export function BoardStrip(props: {
  summary: () => BoardSummary | undefined;
  error: () => string;
  ready: () => boolean;
  onOpenDocs: () => void;
}) {
  const columns = () => props.summary()?.columns ?? [];

  const gridTemplate = () =>
    [
      `${STRIP_MARK}px`,
      `${STRIP_TOTAL}px`,
      ...columns().map(({ name }) => `${stripColumnWidth(name)}px`),
      `minmax(${STRIP_SPACER}px, 1fr)`,
      `${STRIP_FRESH}px`,
    ].join(" ");

  const state = () => {
    if (props.error()) {
      return "no read";
    }
    if (!props.ready()) {
      return "no session";
    }
    return "reading…";
  };

  return (
    <div
      style={{
        display: "grid",
        "align-items": "stretch",
        height: "30px",
        "grid-template-columns": gridTemplate(),
        "border-top": `1px solid ${STRIP_RULE}`,
        "font-size": "12px",
      }}
    >
      <style>
        {HATCH_CSS}
        {STRIP_CSS}
      </style>

      <div style={{ ...STRIP_CELL, padding: "0 0 0 12px" }}>
        <button
          type="button"
          data-zinn-word=""
          title="Zinn documentation: zinn.sh/docs"
          aria-label="Open the Zinn documentation"
          onClick={props.onOpenDocs}
          style={{
            display: "flex",
            "align-items": "center",
            height: "100%",
            padding: 0,
            margin: 0,
            border: 0,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <span aria-hidden="true" innerHTML={ZINN_WORDMARK} />
        </button>
      </div>

      <div style={{ ...STRIP_CELL, gap: "7px" }}>
        <Show
          when={props.summary()}
          fallback={
            <i
              style={{ ...STRIP_LABEL, "font-style": "normal", opacity: 0.62 }}
              title={props.error()}
            >
              {state()}
            </i>
          }
        >
          {(summary: Accessor<BoardSummary>) => (
            <>
              <b style={{ "font-size": "12px", "font-weight": 500 }}>{summary().total}</b>
              <i style={{ ...STRIP_LABEL, "font-style": "normal" }}>tasks</i>
            </>
          )}
        </Show>
      </div>

      <For each={columns()}>
        {(column) => (
          <div style={STRIP_CELL}>
            <i style={{ ...STRIP_LABEL, "font-style": "normal" }}>{column.name}</i>
            <b
              style={{
                "font-family": MONO,
                "font-size": "12px",
                "font-weight": 500,
                "font-variant-numeric": "tabular-nums",
                ...countInk(column.category),
              }}
            >
              {column.count}
            </b>
          </div>
        )}
      </For>

      <div
        data-zinn-hatch=""
        style={{
          "border-right": `1px solid ${STRIP_RULE}`,
          "--zinn-hatch-ink": STRIP_HATCH_INK,
          display: "flex",
          "align-items": "center",
          "justify-content": "flex-end",
          "padding-right": "8px",
          overflow: "hidden",
        } as JSX.CSSProperties}
      />

      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "flex-end",
          padding: "0 9px",
          "font-family": MONO,
          "font-size": "10px",
          opacity: 0.5,
          "font-variant-numeric": "tabular-nums",
          "white-space": "nowrap",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
            "max-width": "100%",
          }}
          title={
            props.error() ||
            (props.summary() ? `Read at ${clock(props.summary()!.readAt)}` : undefined)
          }
        >
          {props.summary() ? `synced ${clock(props.summary()!.readAt)}` : "no read"}
        </span>
      </div>
    </div>
  );
}
