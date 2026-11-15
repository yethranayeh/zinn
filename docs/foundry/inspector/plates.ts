import type { Rect } from "./measure";

/** Fixed plate slot, in CSS px. */
export const PLATE_WIDTH = 104;
export const PLATE_IMAGE_HEIGHT = 56;
export const PLATE_CAPTION_HEIGHT = 14;
export const PLATE_GAP = 6;
const MAX_PLATES = 6;
/** Room around the focused element for its ring and an open tooltip's edge. */
export const RING_ROOM = 8;

export type PlateFit = { x: number; y: number; w: number; h: number; scale: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The crop a plate shows: the focused element, any visible tooltip content and
 * the ring room, clamped to the capture surface.
 */
export function cropFor(
  focus: Rect,
  tooltip: Rect | null,
  surface: { w: number; h: number },
  room = RING_ROOM,
): Rect {
  const left = Math.min(focus.x, tooltip?.x ?? focus.x) - room;
  const top = Math.min(focus.y, tooltip?.y ?? focus.y) - room;
  const right =
    Math.max(focus.x + focus.w, tooltip ? tooltip.x + tooltip.w : focus.x + focus.w) + room;
  const bottom =
    Math.max(focus.y + focus.h, tooltip ? tooltip.y + tooltip.h : focus.y + focus.h) + room;
  const x = clamp(left, 0, surface.w);
  const y = clamp(top, 0, surface.h);
  return {
    x,
    y,
    w: Math.max(clamp(right, 0, surface.w) - x, 0),
    h: Math.max(clamp(bottom, 0, surface.h) - y, 0),
  };
}

/** Scales a crop into a plate's image area, keeping its aspect and centring it. */
export function fitCrop(crop: Rect, area: Rect, inset = 3): PlateFit {
  const availableWidth = Math.max(area.w - inset * 2, 1);
  const availableHeight = Math.max(area.h - inset * 2, 1);
  const scale = Math.min(
    availableWidth / Math.max(crop.w, 1),
    availableHeight / Math.max(crop.h, 1),
  );
  const w = crop.w * scale;
  const h = crop.h * scale;
  return {
    x: area.x + inset + (availableWidth - w) / 2,
    y: area.y + inset + (availableHeight - h) / 2,
    w,
    h,
    scale,
  };
}

/** Maps a surface rect into the plate, using the same fit as the crop. */
export function rectInPlate(rect: Rect, crop: Rect, fit: PlateFit): Rect {
  return {
    x: fit.x + (rect.x - crop.x) * fit.scale,
    y: fit.y + (rect.y - crop.y) * fit.scale,
    w: rect.w * fit.scale,
    h: rect.h * fit.scale,
  };
}

/** How many fixed slots fit across the strip, at least one and at most six. */
export function slotCapacity(
  usableWidth: number,
  slotWidth = PLATE_WIDTH,
  gap = PLATE_GAP,
): number {
  return clamp(Math.floor((usableWidth + gap) / (slotWidth + gap)), 1, MAX_PLATES);
}

/** The stop numbers the strip keeps: the newest replace the oldest. */
export function slotStops(stopNumbers: number[], capacity: number): number[] {
  const kept = clamp(Math.floor(capacity), 1, MAX_PLATES);
  return stopNumbers.slice(Math.max(stopNumbers.length - kept, 0));
}
