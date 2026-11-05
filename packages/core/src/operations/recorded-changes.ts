// Readers of the `changes` JSON stored on activity events. Unrecognized shapes yield no values.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The new value in a `[before, after]` change. */
export function getRecordedNewValue(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  return value[1];
}

export function getRecordedNullableText(value: unknown): Array<string | null> {
  if (value !== null && typeof value !== "string") {
    return [];
  }

  return [value];
}

export function getRecordedLabelNames(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((name): name is string => typeof name === "string");
}

export function getChangedLabelNames(value: unknown, change: "added" | "removed"): Array<string> {
  if (!isRecord(value)) {
    return [];
  }

  return getRecordedLabelNames(value[change]);
}
