import { getCollection } from "astro:content";

/** newest first */
export async function getReleases() {
  const releases = await getCollection("releases");

  return releases.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

export function releaseAnchor(version: string): string {
  return `release-${version.replaceAll(".", "")}`;
}

export function npmPackageUrl(name: "cli" | "core", version: string): string {
  return `https://www.npmjs.com/package/@zinn-dev/${name}/v/${version}`;
}

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
