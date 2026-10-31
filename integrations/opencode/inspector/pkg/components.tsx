/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type { Ctx } from "./types.ts";
import type { CurrentMark } from "./options.ts";
import type { DisplayRow } from "./rows.ts";

import { For, Show, createMemo, createSignal } from "solid-js";

import {
  CHIP_PAD,
  CHIP_PRIORITY,
  CONTEXT_SEPARATOR,
  LABEL_SEPARATOR,
  PRIORITY_COLOR,
  labelColors,
} from "./data.ts";
import { RAIL_COLUMNS, SESSION_GLYPH, priorityLetter } from "./options.ts";
import { truncate } from "./rows.ts";
import { TINT_ALPHA_STRONG, TINT_ALPHA_SUBTLE, inspectorTheme, toneColor } from "./theme.ts";

export function Overflow(props: {
  ctx: Ctx;
  count: number;
  label: string;
  onOpen: () => void;
}): JSX.Element {
  const theme = () => inspectorTheme(props.ctx);
  const [hover, setHover] = createSignal(false);
  const onClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();

    if (hover()) {
      props.onOpen();
    }
  };

  return (
    <box
      flexDirection="row"
      gap={1}
      backgroundColor={hover() ? theme().backgroundElement : "transparent"}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={onClick}
    >
      <text width={RAIL_COLUMNS} flexShrink={0} fg={theme().borderSubtle}>
        │
      </text>
      <text flexShrink={0} fg={theme().textMuted}>{`+${props.count} ${props.label}`}</text>
    </box>
  );
}

export function RailLine(props: {
  ctx: Ctx;
  glyph: string;
  color?: RGBA;
  onMouseDown?: () => void;
  children: JSX.Element;
}): JSX.Element {
  const theme = () => inspectorTheme(props.ctx);

  return (
    <box flexDirection="row" gap={1} onMouseDown={props.onMouseDown}>
      <text width={RAIL_COLUMNS} flexShrink={0} fg={props.color ?? theme().borderSubtle}>
        {props.glyph}
      </text>
      {props.children}
    </box>
  );
}

type MetaPart = {
  text: string;
  color: string | null;
  chip: boolean;
  sep: boolean;
};

export function Row(props: {
  ctx: Ctx;
  row: DisplayRow;
  titleColumns: number;
  metaColumns: number;
  dense: boolean;
  current: CurrentMark;
  markGlyph?: string;
  onOpen: () => void;
}): JSX.Element {
  const theme = () => inspectorTheme(props.ctx);
  const keyColor = toneColor(props.ctx, () => props.row.tone);
  const metaColor = () => theme().textMuted;
  const glyph = () => props.current === "glyph";
  const done = () => props.row.column === "Done";
  const mark = () => {
    if (glyph() && props.row.mine) {
      return props.markGlyph ?? SESSION_GLYPH;
    }

    if (props.row.created) {
      return "+";
    }

    if (!props.dense) {
      return props.row.glyph || "│";
    }

    return "│";
  };
  const markColor = () => {
    if (glyph() && props.row.mine) {
      return theme().accent;
    }

    if (props.row.created) {
      return theme().info;
    }

    if (props.row.unknown) {
      return theme().warning;
    }

    if (done()) {
      return theme().success;
    }

    if (!props.dense && props.row.glyph.length > 0) {
      return keyColor();
    }

    return theme().borderSubtle;
  };
  const railColor = () => (done() ? theme().success : theme().borderSubtle);
  const [hover, setHover] = createSignal(false);
  const onEnter = () => setHover(true);
  const onLeave = () => setHover(false);
  const wash = (color: RGBA) => {
    const [r, g, b] = color.toInts();
    const byte = (n: number) => n.toString(16).padStart(2, "0");
    return `#${byte(r)}${byte(g)}${byte(b)}${hover() ? TINT_ALPHA_STRONG : TINT_ALPHA_SUBTLE}`;
  };
  const background = () =>
    done() ? wash(theme().success) : hover() ? theme().backgroundElement : "transparent";
  const onClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (hover()) {
      props.onOpen();
    }
  };

  const head = (
    <box flexDirection="row" gap={1}>
      <text width={RAIL_COLUMNS} flexShrink={0} fg={markColor()}>
        {mark()}
      </text>

      <text flexShrink={0} fg={keyColor()}>
        {props.row.key}
      </text>
      {!props.dense && (
        <text flexShrink={0} fg={metaColor()}>
          {priorityLetter(props.row.priority)}
        </text>
      )}

      <text wrapMode="none" flexShrink={1} fg={metaColor()}>
        {truncate(props.row.title, props.titleColumns)}
      </text>
    </box>
  );

  const metaPlan = createMemo<MetaPart[]>(() => {
    const budget = props.metaColumns;
    const parts: MetaPart[] = [];
    const contexts: MetaPart[] = [];
    if (props.row.column.length > 0) {
      contexts.push({ text: props.row.column, color: null, chip: false, sep: false });
    }
    if (props.row.priority) {
      contexts.push({
        text: props.row.priority,
        color: PRIORITY_COLOR[props.row.priority] ?? null,
        chip: props.row.priority === CHIP_PRIORITY,
        sep: false,
      });
    }

    let used = contexts.reduce(
      (sum, part) => sum + part.text.length + (part.chip ? CHIP_PAD : 0),
      0,
    );
    used += Math.max(0, contexts.length - 1) * CONTEXT_SEPARATOR.length;
    contexts.forEach((part, index) => {
      if (index > 0) {
        parts.push({ text: CONTEXT_SEPARATOR, color: null, chip: false, sep: true });
      }
      parts.push(part);
    });

    let shown = 0;
    for (let i = 0; i < props.row.labels.length; i++) {
      const label = props.row.labels[i]!;
      const separator =
        contexts.length > 0 || shown > 0 ? (shown > 0 ? LABEL_SEPARATOR : CONTEXT_SEPARATOR) : "";
      const leftovers = props.row.labels.length - i - 1;
      const reserve = leftovers > 0 ? 2 + String(leftovers).length : 0;
      if (used + separator.length + label.length + reserve > budget) {
        break;
      }
      if (separator.length > 0) {
        parts.push({ text: separator, color: null, chip: false, sep: true });
      }
      parts.push({ text: label, color: labelColors().get(label) ?? null, chip: false, sep: false });
      used += separator.length + label.length;
      shown++;
    }

    const hidden = props.row.labels.length - shown;
    if (hidden > 0) {
      const tail = ` +${hidden}`;
      if (used + tail.length <= budget) {
        parts.push({ text: tail, color: null, chip: false, sep: false });
      }
    }
    return parts;
  });

  const meta = () => (
    <box flexDirection="row" gap={1}>
      <text width={RAIL_COLUMNS} flexShrink={0} fg={railColor()}>
        │
      </text>
      <text wrapMode="none" flexShrink={1} fg={metaColor()}>
        <For each={metaPlan()}>
          {(part) => (
            <Show
              when={!part.chip}
              fallback={
                <>
                  <span style={{ fg: metaColor() }}> </span>
                  <span style={{ fg: part.color, bg: `${part.color}${TINT_ALPHA_STRONG}` }}>
                    {part.text}
                  </span>
                  <span style={{ fg: metaColor() }}> </span>
                </>
              }
            >
              <span style={{ fg: part.sep ? theme().borderSubtle : (part.color ?? metaColor()) }}>
                {part.text}
              </span>
            </Show>
          )}
        </For>
      </text>
    </box>
  );

  return (
    <box
      flexDirection={props.dense ? "column" : "row"}
      backgroundColor={background()}
      onMouseOver={onEnter}
      onMouseOut={onLeave}
      onMouseUp={onClick}
    >
      {head}
      <Show when={props.dense}>{meta()}</Show>
    </box>
  );
}
