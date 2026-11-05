/** @jsxImportSource @opentui/solid */
import type { Accessor } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type { Ctx, DetailState, Excerpt, Relation, TaskSummary } from "./types.ts";

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { labelColors, loadDetail, log, PRIORITY_COLOR } from "./data.ts";
import { firstParagraph, truncate } from "./rows.ts";
import { lastMentionExcerpt } from "./scan.ts";
import { inspectorTheme } from "./theme.ts";

const RELATION_ROWS = 3;

export function RelationLine(props: {
  ctx: Ctx;
  relation: Relation;
  onOpen: (key: string) => void;
}): JSX.Element {
  const theme = () => inspectorTheme(props.ctx);
  const arrow = () => (props.relation.direction === "incoming" ? "←" : "→");
  const navigable = () => props.relation.task.status !== "Archived";
  const [hovered, setHovered] = createSignal(false);

  return (
    <box
      width="100%"
      backgroundColor={navigable() && hovered() ? theme().backgroundElement : undefined}
      onMouseOver={() => setHovered(navigable())}
      onMouseOut={() => setHovered(false)}
      onMouseUp={() => {
        if (navigable()) {
          props.onOpen(props.relation.task.key);
        }
      }}
    >
      <text fg={theme().textMuted}>
        {`${arrow()} ${props.relation.type} `}
        <span style={{ fg: navigable() ? theme().accent : theme().textMuted }}>
          {props.relation.task.key}
        </span>
        {` ${truncate(props.relation.task.title, 40)}`}
      </text>
    </box>
  );
}

export function Detail(props: {
  ctx: Ctx;
  taskKey: string;
  unknown: boolean;
  mentions?: ReadonlyMap<string, number>;
  sessionID?: string;
}): JSX.Element {
  const theme = () => inspectorTheme(props.ctx);
  const [key, setKey] = createSignal(props.taskKey);
  const [history, setHistory] = createSignal<readonly string[]>([]);
  const [state, setState] = createSignal<DetailState>({ kind: "loading" });
  const [excerpt, setExcerpt] = createSignal<Excerpt | undefined>();
  const [backHovered, setBackHovered] = createSignal(false);
  const [closeHovered, setCloseHovered] = createSignal(false);

  createEffect(() => {
    const taskKey = key();
    const sessionID = props.sessionID;
    const mentioned = props.mentions?.get(taskKey) !== undefined;
    const mentionExcerpt =
      mentioned && sessionID !== undefined
        ? lastMentionExcerpt(props.ctx, sessionID, taskKey)
        : undefined;
    let alive = true;

    setState({ kind: "loading" });
    setExcerpt(mentionExcerpt);

    const started = Date.now();

    log(props.ctx, "detail loading", { key: taskKey });
    void loadDetail(taskKey).then((result) => {
      log(props.ctx, "detail settled", {
        key: taskKey,
        kind: result.kind,
        ms: Date.now() - started,
        excerpt: mentionExcerpt !== undefined,
      });
      if (alive) {
        setState(result);
      }
    });

    onCleanup(() => {
      alive = false;
    });
  });

  const open = (next: string) => {
    if (next === key()) {
      return;
    }
    setHistory((previous) => [...previous, key()]);
    setKey(next);
  };

  const back = () => {
    const previous = history();
    const target = previous[previous.length - 1];
    if (target === undefined) {
      return;
    }
    setHistory(previous.slice(0, -1));
    setKey(target);
  };

  const mentionLine = () => {
    const count = props.mentions?.get(key());
    if (count === undefined) {
      return undefined;
    }

    return `mentioned ${count} ${count === 1 ? "time" : "times"} in this chat`;
  };

  const body = createMemo<JSX.Element>(() => {
    const current = state();
    if (current.kind === "loading") {
      return <text fg={theme().textMuted}>Loading {key()}…</text>;
    }
    if (current.kind === "error") {
      return (
        <box flexDirection="column" gap={1}>
          <Show when={props.unknown}>
            <text fg={theme().warning}>{key()} is not in this store. Check the task key.</text>
          </Show>
          <text fg={theme().error}>{current.error}</text>
        </box>
      );
    }

    const detail = current.detail;
    return (
      <box flexDirection="column" gap={1}>
        <text fg={theme().text}>
          <b>{detail.title}</b>
        </text>

        <text wrapMode="none" fg={theme().textMuted}>
          <span style={{ fg: theme().text }}>{detail.key}</span>
          <span>{` · ${detail.column} · ${detail.status} · priority `}</span>
          <Show when={detail.priority} fallback={<span>none</span>}>
            <span style={{ fg: PRIORITY_COLOR[detail.priority ?? ""] ?? theme().textMuted }}>
              {detail.priority}
            </span>
          </Show>
        </text>
        <Show
          when={detail.labels.length > 0}
          fallback={<text fg={theme().textMuted}>labels: none</text>}
        >
          <text wrapMode="none" fg={theme().textMuted}>
            <span>{"labels: "}</span>
            <For each={detail.labels}>
              {(label, index) => (
                <>
                  <Show when={index() > 0}>
                    <span>{", "}</span>
                  </Show>
                  <span style={{ fg: labelColors().get(label) ?? theme().textMuted }}>{label}</span>
                </>
              )}
            </For>
          </text>
        </Show>
        <Show when={detail.description.length > 0}>
          <text fg={theme().text}>{firstParagraph(detail.description)}</text>
        </Show>
        <Show when={detail.relations.length > 0}>
          <box flexDirection="column">
            <text fg={theme().textMuted}>
              {detail.relations.length > RELATION_ROWS
                ? `relations: ${detail.relations.length}  ↑↓ scroll`
                : "relations:"}
            </text>
            <Show
              when={detail.relations.length > RELATION_ROWS}
              fallback={
                <For each={detail.relations}>
                  {(relation) => <RelationLine ctx={props.ctx} relation={relation} onOpen={open} />}
                </For>
              }
            >
              <scrollbox
                height={RELATION_ROWS}
                width="100%"
                focused
                ref={(element: ScrollBoxRenderable | undefined) =>
                  setTimeout(() => element?.focus?.(), 0)
                }
              >
                <For each={detail.relations}>
                  {(relation) => <RelationLine ctx={props.ctx} relation={relation} onOpen={open} />}
                </For>
              </scrollbox>
            </Show>
          </box>
        </Show>
        <text fg={theme().textMuted}>{`comments: ${detail.comments}`}</text>
        <Show when={mentionLine()}>
          <text fg={theme().textMuted}>{mentionLine()}</text>
        </Show>
        <Show when={excerpt()}>
          {(value: Accessor<Excerpt>) => (
            <text wrapMode="none" fg={theme().textMuted}>
              <span>last: </span>
              <span>{value().before}</span>
              <span style={{ fg: theme().accent }}>{value().match}</span>
              <span>{value().after}</span>
            </text>
          )}
        </Show>
      </box>
    );
  });

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" width="100%">
        <Show when={history().length > 0}>
          <box
            backgroundColor={backHovered() ? theme().backgroundElement : undefined}
            onMouseOver={() => setBackHovered(true)}
            onMouseOut={() => setBackHovered(false)}
            onMouseUp={back}
          >
            <text fg={theme().accent}>← back</text>
          </box>
        </Show>
        <box flexGrow={1} />
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={closeHovered() ? theme().backgroundElement : undefined}
          onMouseOver={() => setCloseHovered(true)}
          onMouseOut={() => setCloseHovered(false)}
          onMouseUp={() => props.ctx.ui.dialog.clear()}
        >
          <text fg={theme().textMuted}>[X]</text>
        </box>
      </box>
      {body()}
      <text fg={theme().textMuted}>[esc] to close</text>
    </box>
  );
}

export type PickerOption = {
  title: string;
  description: string;
  value: string;
};
export function pickerOptions(
  keys: readonly string[],
  map: Map<string, TaskSummary> | undefined,
  includeUnknown: boolean,
): PickerOption[] {
  const out: PickerOption[] = [];
  for (const key of keys) {
    const summary = map?.get(key);

    if (!summary) {
      if (!includeUnknown) {
        continue;
      }

      out.push({ title: key, description: "not in store", value: key });
      continue;
    }

    const meta = [summary.column, summary.status, summary.priority].filter(
      (part): part is string => typeof part === "string" && part !== "none" && part.length > 0,
    );

    out.push({
      title: `${key} · ${truncate(summary.title, 64)}`,
      description: meta.length > 0 ? meta.join(" · ") : "·",
      value: key,
    });
  }
  return out;
}
export function openDetail(
  ctx: Ctx,
  key: string,
  unknown: boolean,
  mentions?: ReadonlyMap<string, number>,
  sessionID?: string,
): void {
  log(ctx, "row clicked, opening dialog", { key, unknown });
  ctx.ui.dialog.show(
    () => (
      <Detail ctx={ctx} taskKey={key} unknown={unknown} mentions={mentions} sessionID={sessionID} />
    ),
    () => log(ctx, "dialog closed", { key }),
  );
  ctx.ui.dialog.set({ size: "large" });
}
export function openPicker(
  ctx: Ctx,
  title: string,
  keys: readonly string[],
  map: Map<string, TaskSummary> | undefined,
  includeUnknown: boolean,
  mentions?: ReadonlyMap<string, number>,
  sessionID?: string,
): void {
  const options = pickerOptions(keys, map, includeUnknown);

  if (options.length === 0) {
    ctx.ui.toast.show({
      variant: "warning",
      title: "Zinn",
      message: "nothing to pick: no tasks in the store",
    });
    return;
  }

  log(ctx, "picker opened", { title, options: options.length });

  void ctx.ui.dialog.select({ title, placeholder: "search tasks", options }).then((value) => {
    if (value === undefined) {
      return;
    }
    openDetail(ctx, value, includeUnknown, mentions, sessionID);
  });
}
