import type { TaskAttribution } from "./types.js";

export function descriptionLines(text: string | null): Array<string> {
  if (text === null || text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Returns the middle split of a shortest edit path between the two line ranges.
 * Myers's linear-space search uses memory proportional to the line counts, not their product.
 */
function middleSplit(
  before: Array<string>,
  after: Array<string>,
  startBefore: number,
  endBefore: number,
  startAfter: number,
  endAfter: number,
): [number, number] {
  const oldLength = endBefore - startBefore;
  const newLength = endAfter - startAfter;
  const maxDistance = Math.ceil((oldLength + newLength) / 2);
  const offset = maxDistance + 1;
  const forward = new Int32Array(2 * maxDistance + 3).fill(-1);
  const reverse = new Int32Array(forward.length).fill(-1);

  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;

  const delta = oldLength - newLength;
  const oddDelta = delta % 2 !== 0;

  for (let distance = 0; distance <= maxDistance; distance++) {
    for (let diagonal = distance; diagonal >= -distance; diagonal -= 2) {
      const slot = offset + diagonal;
      const insertion =
        diagonal === -distance ||
        (diagonal !== distance && forward[slot - 1]! < forward[slot + 1]!);
      let x = insertion ? forward[slot + 1]! : forward[slot - 1]! + 1;
      let y = x - diagonal;

      while (x < oldLength && y < newLength && before[startBefore + x] === after[startAfter + y]) {
        x++;
        y++;
      }

      forward[slot] = x;
      const reverseDiagonal = delta - diagonal;

      if (
        oddDelta &&
        reverseDiagonal >= -(distance - 1) &&
        reverseDiagonal <= distance - 1 &&
        reverse[offset + reverseDiagonal]! >= 0 &&
        x + reverse[offset + reverseDiagonal]! >= oldLength
      ) {
        return [startBefore + x, startAfter + y];
      }
    }

    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const slot = offset + diagonal;
      const insertion =
        diagonal === -distance ||
        (diagonal !== distance && reverse[slot - 1]! < reverse[slot + 1]!);
      let x = insertion ? reverse[slot + 1]! : reverse[slot - 1]! + 1;
      let y = x - diagonal;

      while (
        x < oldLength &&
        y < newLength &&
        before[endBefore - x - 1] === after[endAfter - y - 1]
      ) {
        x++;
        y++;
      }

      reverse[slot] = x;
      const forwardDiagonal = delta - diagonal;
      if (
        !oddDelta &&
        forwardDiagonal >= -distance &&
        forwardDiagonal <= distance &&
        forward[offset + forwardDiagonal]! >= 0 &&
        x + forward[offset + forwardDiagonal]! >= oldLength
      ) {
        const splitX = forward[offset + forwardDiagonal]!;
        return [startBefore + splitX, startAfter + splitX - forwardDiagonal];
      }
    }
  }
  throw new Error("No description edit path found");
}

/**
 * Matches exact lines with Myers's algorithm.
 * When two moves are equally short, it takes the deletion first.
 */
export function attributeLines(
  before: Array<string>,
  after: Array<string>,
  previous: Array<TaskAttribution | null>,
  attribution: TaskAttribution,
): Array<TaskAttribution | null> {
  const result: Array<TaskAttribution | null> = after.map(() => attribution);
  const pending: Array<[number, number, number, number]> = [[0, before.length, 0, after.length]];

  while (pending.length > 0) {
    let [startBefore, endBefore, startAfter, endAfter] = pending.pop()!;
    while (
      startBefore < endBefore &&
      startAfter < endAfter &&
      before[startBefore] === after[startAfter]
    ) {
      result[startAfter++] = previous[startBefore++] ?? null;
    }

    while (
      startBefore < endBefore &&
      startAfter < endAfter &&
      before[endBefore - 1] === after[endAfter - 1]
    ) {
      result[--endAfter] = previous[--endBefore] ?? null;
    }

    if (startBefore === endBefore || startAfter === endAfter) {
      continue;
    }

    const oldLines = new Set(before.slice(startBefore, endBefore));
    let hasCommonLine = false;

    for (let index = startAfter; index < endAfter; index++) {
      if (oldLines.has(after[index]!)) {
        hasCommonLine = true;
        break;
      }
    }

    if (!hasCommonLine) {
      continue;
    }

    const [splitBefore, splitAfter] = middleSplit(
      before,
      after,
      startBefore,
      endBefore,
      startAfter,
      endAfter,
    );

    pending.push(
      [splitBefore, endBefore, splitAfter, endAfter],
      [startBefore, splitBefore, startAfter, splitAfter],
    );
  }
  return result;
}
