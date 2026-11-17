import type { EventData, WebsiteEvent } from "./site-events";
import { isProductionSite } from "../config/site";

export type { WebsiteEvent } from "./site-events";
export { isWebsiteEvent } from "./site-events";

declare global {
  interface Window {
    umami?: { track: (event: WebsiteEvent, data?: EventData) => Promise<unknown> };
  }
}

// Event data holds fixed labels chosen in code
export function trackEvent(event: WebsiteEvent, data?: EventData): void {
  const trackingAllowed =
    isProductionSite && window.location.hostname === "zinn.sh" && navigator.doNotTrack !== "1";

  if (!trackingAllowed) {
    return;
  }

  try {
    void window.umami?.track(event, data).catch(() => {});
  } catch {}
}
