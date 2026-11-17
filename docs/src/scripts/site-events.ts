export const websiteEvents = [
  "github-click",
  "npm-click",
  "install-copy",
  "prompt-copy",
  "markdown-copy",
  "twitter-click",
  "bluesky-click",
  "command-copy",
  "markdown-open",
  "theme-download",
  "outbound-click",
  "search-open",
  "search-result",
  "search-empty",
  "gallery-scene",
  "performance-flow",
  "performance-trace",
  "pricing-calculator",
] as const;

export type WebsiteEvent = (typeof websiteEvents)[number];

export type EventData = Record<string, string | number>;

export type EventMatch = { event: WebsiteEvent; data?: EventData };

const websiteEventNames: ReadonlySet<string> = new Set(websiteEvents);

export function isWebsiteEvent(name: string): name is WebsiteEvent {
  return websiteEventNames.has(name);
}

const dataAttributePrefix = "data-site-event-";

export function parseSiteEventData(
  attributes: Iterable<readonly [string, string]>,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [name, value] of attributes) {
    if (!name.startsWith(dataAttributePrefix)) {
      continue;
    }

    const suffix = name.slice(dataAttributePrefix.length);
    if (suffix === "" || value === "") {
      continue;
    }

    const key = suffix.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
    data[key] = value;
  }

  return data;
}

type HostMapping = { event: WebsiteEvent; target?: string };

// More specific hosts come first so a subdomain cannot be claimed by a broader entry
const outboundHosts: ReadonlyArray<readonly [string, WebsiteEvent, string?]> = [
  ["raw.githubusercontent.com", "outbound-click", "license"],
  ["addons.mozilla.org", "outbound-click", "mozilla-addons"],
  ["superlogical.com", "outbound-click", "rex-docs"],
  ["opencode.ai", "outbound-click", "opencode-docs"],
  ["github.com", "github-click"],
  ["npmjs.com", "npm-click"],
  ["twitter.com", "twitter-click"],
  ["x.com", "twitter-click"],
  ["bsky.app", "bluesky-click"],
  ["nodejs.org", "outbound-click", "nodejs"],
  ["bun.com", "outbound-click", "bun"],
];

export function hostMapping(hostname: string): HostMapping {
  const normalized = hostname.toLowerCase();
  for (const [host, event, target] of outboundHosts) {
    if (normalized === host || normalized.endsWith(`.${host}`)) {
      return target === undefined ? { event } : { event, target };
    }
  }

  return { event: "outbound-click", target: "external" };
}

export type ResolveEventInput = {
  href: string;
  origin: string;
  hasDownload: boolean;
  explicitEvent: string | null;
  explicitData: Record<string, string>;
};

function absoluteUrl(href: string, origin: string): URL | null {
  if (!href) {
    return null;
  }

  try {
    return new URL(href, origin);
  } catch {
    return null;
  }
}

export function resolveEvent(input: ResolveEventInput): EventMatch | null {
  const { explicitEvent, explicitData } = input;

  if (explicitEvent === "ignore") {
    return null;
  }

  const hasExplicitEvent = explicitEvent !== null && explicitEvent !== "";
  if (hasExplicitEvent && !isWebsiteEvent(explicitEvent!)) {
    return null;
  }

  let mapping: HostMapping | null = null;
  if (!input.hasDownload) {
    const url = absoluteUrl(input.href, input.origin);
    if (
      url &&
      url.origin !== input.origin &&
      url.protocol !== "mailto:" &&
      url.protocol !== "tel:"
    ) {
      mapping = hostMapping(url.hostname);
    }
  }

  if (!hasExplicitEvent && mapping === null) {
    return null;
  }

  const event = hasExplicitEvent ? (explicitEvent as WebsiteEvent) : mapping!.event;
  const data: EventData = { ...explicitData };
  const target = explicitData.target ?? mapping?.target;
  if (target !== undefined) {
    data.target = target;
  }

  return Object.keys(data).length > 0 ? { event, data } : { event };
}

let installed = false;

export function setupSiteEvents(track: (event: WebsiteEvent, data?: EventData) => void): void {
  if (installed) {
    return;
  }

  function activate(event: MouseEvent) {
    if (event.type === "auxclick" && event.button !== 1) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const explicitElement = target.closest<HTMLElement>("[data-site-event]");
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (event.type === "auxclick" && !anchor) {
      return;
    }

    if (!explicitElement && !anchor) {
      return;
    }

    if (target.closest("[data-lightbox-original]")) {
      return;
    }

    const attributeSource = explicitElement ?? anchor!;
    const attributes = attributeSource
      .getAttributeNames()
      .map((name) => [name, attributeSource.getAttribute(name) ?? ""] as const);
    const explicitData = parseSiteEventData(attributes);

    const match = resolveEvent({
      href: anchor?.getAttribute("href") ?? "",
      origin: location.origin,
      hasDownload: anchor?.hasAttribute("download") ?? false,
      explicitEvent: explicitElement?.getAttribute("data-site-event") ?? null,
      explicitData,
    });
    if (!match) {
      return;
    }

    if (match.data) {
      track(match.event, match.data);
    } else {
      track(match.event);
    }
  }

  document.addEventListener("click", activate);
  document.addEventListener("auxclick", activate);

  installed = true;
}
