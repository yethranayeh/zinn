type WebsiteEvent = "github-click" | "npm-click" | "install-copy";

declare global {
  interface Window {
    umami?: { track: (event: WebsiteEvent) => Promise<unknown> };
  }
}

export function trackEvent(event: WebsiteEvent): void {
  const trackingAllowed =
    import.meta.env.PROD && window.location.hostname === "zinn.sh" && navigator.doNotTrack !== "1";
  if (!trackingAllowed) {
    return;
  }
  try {
    void window.umami?.track(event).catch(() => {});
  } catch {}
}
