const grouped = new Intl.NumberFormat("en-US");

/** A whole number with thousands separators */
export function groupedNumber(value: number) {
  return grouped.format(value);
}

/** Exact byte count, grouped as a script or a receipt would print it */
export function exactBytes(bytes: number) {
  return `${groupedNumber(bytes)} B`;
}

/** Smallest size shown in whole kilobytes. Below it, one decimal place keeps 1.6 KB from rounding to 2 KB */
const wholeKilobytesFrom = 10_000;

/** Decimal units, matching how npm reports package sizes */
export function sizeLabel(bytes: number) {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= wholeKilobytesFrom) {
    return `${Math.round(bytes / 1000)} KB`;
  }
  if (bytes >= 1000) {
    return `${(bytes / 1000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/** Memory in whole decimal megabytes, the same units as the sizes */
export function memoryLabel(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Decimal units with one decimal place, for output sizes between 1 KB and 1 MB */
export function outputLabel(bytes: number) {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1000) {
    return `${(bytes / 1000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
