/** Time the pointer may be away from both the trigger and the card before the card closes, in milliseconds. */
const closeDelay = 300;

interface OpenCard {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  content: HTMLElement;
}

/** Wires every hover card under `scope`. Only one card is open at a time. */
export function initHoverCards(scope: ParentNode) {
  let open: OpenCard | undefined;
  let closeTimer: number | undefined;
  let isReturningFocus = false;

  function close() {
    window.clearTimeout(closeTimer);
    if (open === undefined) {
      return;
    }
    open.content.hidden = true;
    open.trigger.setAttribute("aria-expanded", "false");
    open = undefined;
  }

  function closeSoon() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(close, closeDelay);
  }

  /** The viewport y that the card must stay below: the boundary element's bottom edge, or the top of the viewport. */
  function topLimit(root: HTMLElement) {
    const selector = root.dataset.hoverCardBoundary;
    return selector === undefined
      ? 0
      : (document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0);
  }

  function show(card: OpenCard) {
    window.clearTimeout(closeTimer);
    if (open?.trigger === card.trigger) {
      return;
    }
    close();
    const { root, trigger, content } = card;
    content.hidden = false;
    // Above the trigger unless the card would not fit between the trigger and the limit
    const roomAbove = root.getBoundingClientRect().top - topLimit(root);
    content.toggleAttribute("data-below", content.offsetHeight > roomAbove);
    trigger.setAttribute("aria-expanded", "true");
    open = card;
  }

  for (const root of scope.querySelectorAll<HTMLElement>("[data-hover-card]")) {
    const trigger = root.querySelector<HTMLButtonElement>("[data-hover-card-trigger]")!;
    const content = root.querySelector<HTMLElement>("[data-hover-card-content]")!;
    const card = { root, trigger, content };
    // The card sits inside the root, so leaving the root means leaving the trigger and the card
    root.addEventListener("mouseenter", () => show(card));
    root.addEventListener("mouseleave", closeSoon);
    trigger.addEventListener("focus", () => {
      if (!isReturningFocus) {
        show(card);
      }
    });
    // A click only opens, for pointers that never hover, such as touch
    trigger.addEventListener("click", () => show(card));
    root.addEventListener("focusout", (event) => {
      if (!root.contains(event.relatedTarget as Node | null)) {
        close();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || open === undefined) {
      return;
    }
    const { trigger } = open;
    close();
    isReturningFocus = true;
    trigger.focus();
    isReturningFocus = false;
  });
}
