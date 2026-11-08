/** Order statistics over one command's runs. */

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("median needs at least one value");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Nearest rank: sort the values and take index ceil(fraction * n) - 1. */
export function nearestRankPercentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error("a percentile needs at least one value");
  }
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(`The percentile fraction must be in (0, 1]: ${fraction}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, rank)]!;
}

const P95_FRACTION = 0.95;

export function p95(values: readonly number[]): number {
  return nearestRankPercentile(values, P95_FRACTION);
}
