/** Reads the sample stream powermetrics writes with `-f plist`. */

import { parsePlist, plistPath, type PlistDict } from "./plist.ts";

export type PowerSample = {
  /** Unix seconds when the sample's interval starts. */
  startSeconds: number;
  /** Unix seconds when the sample's interval ends. */
  endSeconds: number;
  /** Estimated CPU, GPU and ANE power in milliwatts. */
  powerMw: number;
  /** The interval length in seconds. */
  seconds: number;
  record: PlistDict;
};

const NANOSECONDS_PER_SECOND = 1e9;
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * Splits the NUL-separated plist stream and keeps usable samples.
 * A final chunk cut off when powermetrics stopped does not parse and is skipped.
 */
export function parsePowerLog(text: string): PowerSample[] {
  const samples: PowerSample[] = [];
  for (const chunk of text.split("\0")) {
    if (chunk.trim().length === 0) {
      continue;
    }
    let record: PlistDict;
    try {
      record = parsePlist(chunk);
    } catch {
      continue;
    }
    const power = plistPath(record, "processor.combined_power");
    const elapsed = record.elapsed_ns;
    const timestamp = record.timestamp;
    if (
      typeof power !== "number" ||
      typeof elapsed !== "number" ||
      !(timestamp instanceof Date) ||
      elapsed <= 0
    ) {
      continue;
    }
    const seconds = elapsed / NANOSECONDS_PER_SECOND;
    const endSeconds = timestamp.getTime() / MILLISECONDS_PER_SECOND;
    samples.push({
      startSeconds: endSeconds - seconds,
      endSeconds,
      powerMw: power,
      seconds,
      record,
    });
  }
  return samples;
}

/** Samples whose whole interval lies inside the window. */
export function samplesInside(
  samples: readonly PowerSample[],
  startSeconds: number,
  endSeconds: number,
): PowerSample[] {
  return samples.filter(
    (sample) => sample.startSeconds >= startSeconds && sample.endSeconds <= endSeconds,
  );
}

/** Duration-weighted mean power in milliwatts, or undefined when no samples fall inside. */
export function meanPowerMw(
  samples: readonly PowerSample[],
  startSeconds: number,
  endSeconds: number,
): number | undefined {
  const inside = samplesInside(samples, startSeconds, endSeconds);
  if (inside.length === 0) {
    return undefined;
  }
  let energy = 0;
  let seconds = 0;
  for (const sample of inside) {
    energy += sample.powerMw * sample.seconds;
    seconds += sample.seconds;
  }
  return energy / seconds;
}
