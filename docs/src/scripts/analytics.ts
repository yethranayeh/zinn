import { isProductionSite } from "../config/site";

export type WebsiteEvent =
  | "github-click"
  | "npm-click"
  | "install-copy"
  | "prompt-copy"
  | "markdown-copy"
  | "twitter-click"
  | "bluesky-click";

declare global {
  interface Window {
    umami?: { track: (event: WebsiteEvent) => Promise<unknown> };
  }
}

export function trackEvent(event: WebsiteEvent): void {
  const trackingAllowed =
    isProductionSite && window.location.hostname === "zinn.sh" && navigator.doNotTrack !== "1";

  if (!trackingAllowed) {
    return;
  }
  try {
    void window.umami?.track(event).catch(() => {});
  } catch {}
}
