import { RELEASE_MODE } from "./release-identity.js";

export type ReleaseMode = "source" | "published";

/** Whether a package version is a prerelease, such as `0.39.0-dev`. */
export function isPrerelease(version: string) {
  return version.includes("-");
}

/** Core's own identity, independent of the client consuming it. */
export function readCoreReleaseMode() {
  return RELEASE_MODE;
}
