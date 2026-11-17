import { expect, test } from "bun:test";

import { tasksBucket } from "../src/components/pricing/calculator-scale";
import {
  hostMapping,
  isWebsiteEvent,
  parseSiteEventData,
  resolveEvent,
  websiteEvents
} from "../src/scripts/site-events";

test("the event guard accepts every named event and rejects other names", () => {
  for (const name of websiteEvents) {
    expect(isWebsiteEvent(name)).toBe(true);
  }
  expect(isWebsiteEvent("ignore")).toBe(false);
  expect(isWebsiteEvent("unknown-event")).toBe(false);
  expect(isWebsiteEvent("")).toBe(false);
});

test("the Tier B interaction events are in the named event list", () => {
  for (const name of ["gallery-scene", "performance-flow", "performance-trace", "pricing-calculator"]) {
    expect(websiteEvents).toContain(name);
    expect(isWebsiteEvent(name)).toBe(true);
  }
});

test("task counts map to the five fixed bucket labels at their boundaries", () => {
  const boundaries = [
    [1, "1-9"],
    [9, "1-9"],
    [10, "10-99"],
    [99, "10-99"],
    [100, "100-999"],
    [999, "100-999"],
    [1000, "1000-9999"],
    [9999, "1000-9999"],
    [10000, "10000+"]
  ] as const;
  for (const [tasks, bucket] of boundaries) {
    expect(tasksBucket(tasks)).toBe(bucket);
  }
});

test("a data-site-event-target attribute becomes a data key", () => {
  expect(parseSiteEventData([["data-site-event-target", "_blank"]])).toEqual({ target: "_blank" });
});

test("a multiword key becomes camelCase", () => {
  expect(parseSiteEventData([["data-site-event-download-size", "1234"]])).toEqual({ downloadSize: "1234" });
});

test("the event name attribute is not a data key", () => {
  expect(parseSiteEventData([["data-site-event", "github-click"]])).toEqual({});
});

test("an empty suffix is ignored", () => {
  expect(parseSiteEventData([["data-site-event-", "ignored"]])).toEqual({});
});

test("an empty value is dropped", () => {
  expect(parseSiteEventData([["data-site-event-target", ""]])).toEqual({});
});

const origin = "https://zinn.sh";

test("each mapped host resolves to its event and fixed target", () => {
  expect(hostMapping("github.com")).toEqual({ event: "github-click" });
  expect(hostMapping("npmjs.com")).toEqual({ event: "npm-click" });
  expect(hostMapping("x.com")).toEqual({ event: "twitter-click" });
  expect(hostMapping("twitter.com")).toEqual({ event: "twitter-click" });
  expect(hostMapping("bsky.app")).toEqual({ event: "bluesky-click" });
  expect(hostMapping("nodejs.org")).toEqual({ event: "outbound-click", target: "nodejs" });
  expect(hostMapping("bun.com")).toEqual({ event: "outbound-click", target: "bun" });
  expect(hostMapping("opencode.ai")).toEqual({ event: "outbound-click", target: "opencode-docs" });
  expect(hostMapping("superlogical.com")).toEqual({ event: "outbound-click", target: "rex-docs" });
  expect(hostMapping("addons.mozilla.org")).toEqual({
    event: "outbound-click",
    target: "mozilla-addons"
  });
  expect(hostMapping("raw.githubusercontent.com")).toEqual({
    event: "outbound-click",
    target: "license"
  });
});

test("host matching accepts a subdomain at a dot boundary but not a lookalike", () => {
  expect(hostMapping("gist.github.com")).toEqual({ event: "github-click" });
  expect(hostMapping("notgithub.com")).toEqual({ event: "outbound-click", target: "external" });
  expect(hostMapping("docs.nodejs.org")).toEqual({ event: "outbound-click", target: "nodejs" });
});

const plainLink = {
  origin,
  hasDownload: false,
  explicitEvent: null,
  explicitData: {}
};

test("an unknown external host uses the external target", () => {
  expect(resolveEvent({ ...plainLink, href: "https://example.com/page" })).toEqual({
    event: "outbound-click",
    data: { target: "external" }
  });
});

test("an explicit event wins over the host map and an explicit target wins over the default", () => {
  expect(
    resolveEvent({
      ...plainLink,
      href: "https://addons.mozilla.org/foo",
      explicitEvent: "outbound-click",
      explicitData: { target: "mozilla-addons-halftone" }
    })
  ).toEqual({ event: "outbound-click", data: { target: "mozilla-addons-halftone" } });
});

test("an explicit event without a link carries its own data", () => {
  expect(
    resolveEvent({
      ...plainLink,
      href: "",
      explicitEvent: "theme-download",
      explicitData: { theme: "rex-dark" }
    })
  ).toEqual({ event: "theme-download", data: { theme: "rex-dark" } });
});

test("a plain external GitHub link fires github-click once", () => {
  expect(resolveEvent({ ...plainLink, href: "https://gist.github.com/user/1" })).toEqual({
    event: "github-click"
  });
});

test("same-origin, mailto, tel, download and ignore links do not fire", () => {
  expect(resolveEvent({ ...plainLink, href: "/docs/install" })).toBeNull();
  expect(resolveEvent({ ...plainLink, href: "https://zinn.sh/docs" })).toBeNull();
  expect(resolveEvent({ ...plainLink, href: "mailto:hello@zinn.sh" })).toBeNull();
  expect(resolveEvent({ ...plainLink, href: "tel:+123" })).toBeNull();
  expect(resolveEvent({ ...plainLink, href: "https://github.com/zinn", hasDownload: true })).toBeNull();
  expect(
    resolveEvent({ ...plainLink, href: "https://github.com/zinn", explicitEvent: "ignore" })
  ).toBeNull();
});
