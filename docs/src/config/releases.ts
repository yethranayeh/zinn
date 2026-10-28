export interface Release {
  version: string;
  name?: string;
  date: string;
  cli: string;
  core: string;
}

export const releases: Record<string, Release> = {
  "0.42.0": { version: "0.42.0", date: "2026-10-24", cli: "0.42.0", core: "0.31.0" },
  "0.41.0": { version: "0.41.0", date: "2026-10-18", cli: "0.41.0", core: "0.30.0" },
  "0.40.0": { version: "0.40.0", date: "2026-10-15", cli: "0.40.0", core: "0.29.0" },
  "0.39.0": { version: "0.39.0", date: "2026-10-11", cli: "0.39.0", core: "0.28.0" },
  "0.38.0": { version: "0.38.0", date: "2026-10-10", cli: "0.38.0", core: "0.27.0" },
  "0.37.0": { version: "0.37.0", name: "Eridu", date: "2026-10-08", cli: "0.37.0", core: "0.26.0" },
};

export function getRelease(version: string): Release {
  const release = releases[version];

  if (release === undefined) {
    throw new Error(`Unknown release ${version}.`);
  }

  return release;
}

export function releaseAnchor(version: string): string {
  return `release-${version.replaceAll(".", "")}`;
}

export function npmPackageUrl(name: "cli" | "core", version: string): string {
  return `https://www.npmjs.com/package/@zinn-dev/${name}/v/${version}`;
}

// Abbreviated months keep a period except May.
const SHORT_MONTHS = [
  "Jan.",
  "Feb.",
  "Mar.",
  "Apr.",
  "May",
  "Jun.",
  "Jul.",
  "Aug.",
  "Sep.",
  "Oct.",
  "Nov.",
  "Dec.",
];

export function formatReleaseDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const monthLabel = SHORT_MONTHS[month - 1] ?? "";

  return `${day} ${monthLabel} ${year}`;
}
