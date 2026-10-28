/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import type { Ctx, DetailState, Relation, TaskSummary } from "./types.ts";

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { labelColors, loadDetail, log, PRIORITY_COLOR } from "./data.ts";
import { firstParagraph, truncate } from "./rows.ts";
import { panelTheme } from "./theme.ts";

export function RelationLine(props: { ctx: Ctx; relation: Relation }): JSX.Element {
  const theme = () => panelTheme(props.ctx);
  const arrow = () => (props.relation.direction === "incoming" ? "←" : "→");

  return (
    <text fg={theme().textMuted}>
      {`${arrow()} ${props.relation.type} ${props.relation.task.key} ${truncate(props.relation.task.title, 40)}`}
    </text>
  );
}

export function Detail(props: { ctx: Ctx; taskKey: string; unknown: boolean }): JSX.Element {
  const theme = () => panelTheme(props.ctx);
  const [state, setState] = createSignal<DetailState>({ kind: "loading" });
  let alive = true;

  onMount(() => {
    const started = Date.now();
    log(props.ctx, "detail loading", { key: props.taskKey });
    onCleanup(() => {
      alive = false;
    });
    void loadDetail(props.taskKey).then((result) => {
      log(props.ctx, "detail settled", {
        key: props.taskKey,
        kind: result.kind,
        ms: Date.now() - started,
      });
      if (!alive) {
        return;
      }
      setState(result);
    });
  });

  const body = createMemo<JSX.Element>(() => {
    const current = state();
    if (current.kind === "loading") {
      return <text fg={theme().textMuted}>Loading {props.taskKey}…</text>;
    }
    if (current.kind === "error") {
      return (
        <box flexDirection="column" gap={1}>
          <Show when={props.unknown}>
            <text fg={theme().warning}>
              {props.taskKey} is not in this store. Check the task key.
            </text>
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
                  <span style={{ fg: labelColors.get(label) ?? theme().textMuted }}>{label}</span>
                </>
              )}
            </For>
          </text>
        </Show>
        <Show when={detail.relations.length > 0}>
          <box flexDirection="column">
            <text fg={theme().textMuted}>relations:</text>
            <For each={detail.relations}>
              {(relation) => <RelationLine ctx={props.ctx} relation={relation} />}
            </For>
          </box>
        </Show>
        <text fg={theme().textMuted}>{`comments: ${detail.comments}`}</text>
        <Show when={detail.description.length > 0}>
          <text fg={theme().text}>{firstParagraph(detail.description)}</text>
        </Show>
        <text fg={theme().textMuted}>esc closes</text>
      </box>
    );
  });

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2}>
      {body()}
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
export function openDetail(ctx: Ctx, key: string, unknown: boolean): void {
  log(ctx, "row clicked, opening dialog", { key, unknown });
  ctx.ui.dialog.show(
    () => <Detail ctx={ctx} taskKey={key} unknown={unknown} />,
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
    openDetail(ctx, value, includeUnknown);
  });
}
