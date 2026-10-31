import type { CollectionEntry } from "astro:content";
import type { IntegrationLine } from "./release-lines";

import { getCollection } from "astro:content";
import { integrationLines } from "./release-lines";

type ReleaseEntry = CollectionEntry<"releases"> | CollectionEntry<"integrationReleases">;

export interface ReleasePackage {
  label: string;
  url: string;
}

export interface ChangelogRelease {
  anchor: string;
  /** Zinn releases show the version alone, integration releases lead with the integration's name. */
  heading: string;
  lineLabel: string;
  version: string;
  name?: string;
  date: string;
  packages: ReleasePackage[];
  entry: ReleaseEntry;
}

/** Newest first. Zinn releases come before integration releases from the same day. */
export async function getReleases(): Promise<ChangelogRelease[]> {
  const zinnReleases = (await getCollection("releases")).map((entry): ChangelogRelease => {
    const { version, name, date, cli, core } = entry.data;

    return {
      anchor: releaseAnchor(version),
      heading: version,
      lineLabel: "Zinn",
      version,
      name,
      date,
      packages: [
        { label: `CLI ${cli}`, url: npmPackageUrl("cli", cli) },
        { label: `Core ${core}`, url: npmPackageUrl("core", core) },
      ],
      entry,
    };
  });

  const integrationReleases = (await getCollection("integrationReleases")).map(
    (entry): ChangelogRelease => {
      const folder = entry.id.split("/")[0] ?? "";
      if (!isIntegrationLine(folder)) {
        throw new Error(
          `src/releases/${folder} is not a known integration: ${Object.keys(integrationLines).join(", ")}`,
        );
      }

      const { label, packageName } = integrationLines[folder];
      const { version, date } = entry.data;

      return {
        anchor: releaseAnchor(version, folder),
        heading: `${label} ${version}`,
        lineLabel: label,
        version,
        date,
        packages: [
          {
            label: `@zinn-dev/${packageName} ${version}`,
            url: npmPackageUrl(packageName, version),
          },
        ],
        entry,
      };
    },
  );
  const zinnFirst = (release: ChangelogRelease) =>
    release.entry.collection === "releases" ? 0 : 1;

  return [...zinnReleases, ...integrationReleases].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      zinnFirst(a) - zinnFirst(b) ||
      b.version.localeCompare(a.version, undefined, { numeric: true }),
  );
}

function isIntegrationLine(folder: string): folder is IntegrationLine {
  return Object.hasOwn(integrationLines, folder);
}

/** Zinn anchors stay `release-<digits>` because published links use them. */
export function releaseAnchor(version: string, integration?: IntegrationLine): string {
  const digits = version.replaceAll(".", "");

  return integration ? `release-${integration}-${digits}` : `release-${digits}`;
}

export function npmPackageUrl(name: string, version: string): string {
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
