import type { Range, RegionId } from "./example";
import { notes, paint, rangesOf, regions } from "./example";

const NOTE_SELECTOR = "[data-note]";
const knownIds = new Set<string>(regions.map((region) => region.id));

interface Bracket {
  id: RegionId;
  range: Range;
  top: HTMLElement;
  bottom: HTMLElement;
  tag: HTMLElement;
}

export function setupBlameNotes(init: HTMLElement) {
  const notesRoot = init.closest<HTMLElement>("[data-notes]");
  const column = notesRoot?.parentElement;
  const panel = column?.querySelector<HTMLElement>("[data-blame-panel]");
  const bracketsRoot = column?.querySelector<HTMLElement>("[data-brackets]");

  if (!notesRoot || !column || !panel || !bracketsRoot) {
    return;
  }

  const root = notesRoot;
  const columnEl = column;
  const panelEl = panel;

  let hoverId: RegionId | null = null;
  let focusId: RegionId | null = null;
  let tapId: RegionId | null = null;
  let lastPointerType = "";

  const ruleClass = "absolute left-2 right-2 h-0 border-t border-dashed border-limestone/55";
  const tagClass =
    "absolute right-3 -translate-y-1/2 bg-soot px-1 font-mono text-[10px] leading-none tracking-[0.08em] text-limestone tabular-nums";
  const brackets: Array<Bracket> = [];

  for (const region of regions) {
    const number = notes.find((note) => note.id === region.id)?.number ?? "";

    for (const range of rangesOf(region)) {
      const top = document.createElement("span");
      const bottom = document.createElement("span");
      const tag = document.createElement("span");

      top.className = ruleClass;
      bottom.className = ruleClass;
      tag.className = tagClass;

      top.hidden = true;
      bottom.hidden = true;
      tag.hidden = true;
      tag.textContent = number;

      bracketsRoot.append(top, bottom, tag);
      brackets.push({ id: region.id, range, top, bottom, tag });
    }
  }

  function readId(element: Element | null): RegionId | null {
    const note = element?.closest<HTMLElement>(NOTE_SELECTOR) ?? null;
    const value = note?.dataset.note;
    return value !== undefined && knownIds.has(value) ? (value as RegionId) : null;
  }

  function placeBrackets() {
    const columnBox = columnEl.getBoundingClientRect();
    if (columnBox.height === 0) {
      return;
    }

    for (const bracket of brackets) {
      const first = panelEl.querySelector<HTMLElement>(`[data-line="${bracket.range.start}"]`);
      const last = panelEl.querySelector<HTMLElement>(`[data-line="${bracket.range.end}"]`);
      if (!first || !last) {
        continue;
      }

      const firstBox = first.getBoundingClientRect();
      const lastBox = last.getBoundingClientRect();
      const top = firstBox.top - columnBox.top;
      const bottom = lastBox.bottom - columnBox.top;

      bracket.top.style.top = `${top}px`;
      bracket.bottom.style.top = `${bottom}px`;
      bracket.tag.style.top = `${top}px`;
    }
  }

  function update() {
    const active = hoverId ?? focusId ?? tapId;
    paint(panelEl, active);
    placeBrackets();

    for (const note of root.querySelectorAll<HTMLElement>(NOTE_SELECTOR)) {
      note.toggleAttribute("data-active", note.dataset.note === active);
      note
        .querySelector<HTMLButtonElement>("[data-note-toggle]")
        ?.setAttribute("aria-pressed", String(note.dataset.note === tapId));
    }

    for (const bracket of brackets) {
      const shown = bracket.id === active;
      bracket.top.hidden = !shown;
      bracket.bottom.hidden = !shown;
      bracket.tag.hidden = !shown;
    }
  }

  root.addEventListener("pointerover", (event) => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.pointerType === "touch") {
      return;
    }
    const id = readId(pointerEvent.target as Element);
    if (id === null) {
      return;
    }
    hoverId = id;
    update();
  });

  root.addEventListener("pointerleave", (event) => {
    if ((event as PointerEvent).pointerType === "touch") {
      return;
    }
    hoverId = null;
    update();
  });

  root.addEventListener("pointerdown", (event) => {
    lastPointerType = (event as PointerEvent).pointerType;
    if (lastPointerType !== "touch") {
      focusId = null;
    }
  });

  root.addEventListener("click", (event) => {
    const toggle = (event.target as Element).closest("[data-note-toggle]");

    if (toggle !== null) {
      const id = readId(toggle);
      if (id === null) {
        return;
      }
      tapId = tapId === id ? null : id;
      update();
      return;
    }

    const id = readId(event.target as Element);
    if (id === null || lastPointerType !== "touch") {
      return;
    }
    tapId = tapId === id ? null : id;
    hoverId = null;
    focusId = null;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.contains(focused)) {
      focused.blur();
    }
    update();
  });

  root.addEventListener("focusin", (event) => {
    const target = event.target as Element;
    const note = target.closest<HTMLElement>(NOTE_SELECTOR);
    if (!note || !target.matches(":focus-visible")) {
      return;
    }
    const id = readId(note);
    if (id === null) {
      return;
    }
    focusId = id;
    update();
  });

  root.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) {
      return;
    }
    focusId = null;
    update();
  });

  document.addEventListener("click", (event) => {
    if (root.contains(event.target as Node)) {
      return;
    }
    tapId = null;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.contains(focused)) {
      focused.blur();
    }
    update();
  });

  new ResizeObserver(() => {
    placeBrackets();
  }).observe(panelEl);

  void document.fonts.ready.then(placeBrackets);
  placeBrackets();
  update();
}
