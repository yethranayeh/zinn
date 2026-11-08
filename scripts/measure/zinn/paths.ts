/** Path containment checks for cache folders and scratch runs. */

import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

/** Resolves a path through its nearest existing ancestor, so links cannot escape a check. */
export function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  const missingSegments: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const real = realpathSync(current);
      return path.join(real, ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/** Returns the canonical candidate, or throws when it is not a strict child of parent. */
export function assertInside(candidate: string, parent: string, description: string): string {
  const canonicalCandidate = canonicalPath(candidate);
  const canonicalParent = canonicalPath(parent);
  if (canonicalCandidate === canonicalParent || !isInside(canonicalCandidate, canonicalParent)) {
    throw new Error(`Refusing to use ${description} outside ${parent}: ${candidate}`);
  }
  return canonicalCandidate;
}

/** A scratch directory directly under the runs folder. */
export function resolveScratchDirectory(runsDirectory: string, name: string): string {
  return assertInside(path.join(runsDirectory, name), runsDirectory, "a scratch directory");
}

export async function removeRunDirectory(
  runDirectory: string,
  runsDirectory: string,
): Promise<void> {
  const canonicalRun = canonicalPath(runDirectory);
  const canonicalRuns = canonicalPath(runsDirectory);
  if (canonicalRun === canonicalRuns || !isInside(canonicalRun, canonicalRuns)) {
    throw new Error(`Refusing to remove a run directory outside ${runsDirectory}: ${runDirectory}`);
  }
  await rm(runDirectory, { recursive: true, force: true });
}
