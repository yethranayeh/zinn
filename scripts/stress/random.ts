/**
 * Seeded randomness for the stress harness.
 * Runs under both Bun and Node, so it uses only erasable TypeScript syntax.
 */

const UINT32_RANGE = 2 ** 32;

/** mulberry32: a small, fast 32-bit generator. Good enough to pick operations and delays. */
export function createRandom(seed: number) {
  let state = seed >>> 0;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  return {
    /** A float in [0, 1). */
    next,
    /** An integer in [min, max], both included. */
    integer(min: number, max: number) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(probability: number) {
      return next() < probability;
    },
    pick<T>(items: ReadonlyArray<T>): T {
      if (items.length === 0) {
        throw new Error("Cannot pick from an empty list");
      }

      return items[Math.floor(next() * items.length)]!;
    },
    /** Picks a key with probability proportional to its weight. */
    weighted<K extends string>(weights: Record<K, number>): K {
      const entries = Object.entries(weights) as Array<[K, number]>;
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let remaining = next() * total;

      for (const [key, weight] of entries) {
        remaining -= weight;
        if (remaining < 0) {
          return key;
        }
      }

      return entries[entries.length - 1]![0];
    },
    text(length: number) {
      const alphabet = "abcdefghijklmnopqrstuvwxyz      ";
      let result = "";

      for (let index = 0; index < length; index++) {
        result += alphabet[Math.floor(next() * alphabet.length)];
      }

      return result;
    },
  };
}

export type Random = ReturnType<typeof createRandom>;

/** Derives a child seed from a parent seed and a label, so each scenario and iteration has its own stream. */
export function deriveSeed(seed: number, label: string | number) {
  let hash = (seed ^ 0x9e3779b9) >>> 0;

  for (const character of String(label)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }

  return hash;
}
