import { describe, expect, it } from "vitest";
import {
  CHROME_ALARM_LIMIT,
  type DiscardPolicy,
  isHostDenylisted,
  isSpecialDiscardURL,
  selectDiscardCandidates,
} from "./discard";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const POLICY: DiscardPolicy = {
  afterMinutes: 60,
  ignorePinned: true,
  ignoreAudible: true,
  hostPrefixDenylist: ["archive."],
  pauseWhenOffline: true,
};

let nextId = 1;
function tab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: nextId++,
    url: "https://example.com/page",
    lastAccessed: NOW - 2 * HOUR,
    active: false,
    pinned: false,
    audible: false,
    discarded: false,
    ...overrides,
  } as chrome.tabs.Tab;
}

const sweep = (tabs: chrome.tabs.Tab[], online = true) =>
  selectDiscardCandidates(tabs, POLICY, { now: NOW, online });

describe("selectDiscardCandidates", () => {
  it("selects a tab idle past the window", () => {
    const t = tab();
    expect(sweep([t])).toEqual([t.id]);
  });

  it("leaves a tab still inside the window", () => {
    expect(sweep([tab({ lastAccessed: NOW - 30 * 60 * 1000 })])).toEqual([]);
  });

  it("discards exactly at the boundary", () => {
    const t = tab({ lastAccessed: NOW - HOUR });
    expect(sweep([t])).toEqual([t.id]);
  });

  it("skips active, pinned, audible and already-discarded tabs", () => {
    expect(sweep([tab({ active: true })])).toEqual([]);
    expect(sweep([tab({ pinned: true })])).toEqual([]);
    expect(sweep([tab({ audible: true })])).toEqual([]);
    expect(sweep([tab({ discarded: true })])).toEqual([]);
  });

  it("skips browser-internal and file URLs", () => {
    expect(sweep([tab({ url: "chrome://settings" })])).toEqual([]);
    expect(sweep([tab({ url: "file:///Users/beau/notes.html" })])).toEqual([]);
    expect(sweep([tab({ url: "about:blank" })])).toEqual([]);
  });

  it("honors the host denylist", () => {
    expect(sweep([tab({ url: "https://archive.today/abc" })])).toEqual([]);
    // web.archive.org just serves snapshots, so it stays discardable.
    const wayback = tab({ url: "https://web.archive.org/web/2020/https://x.com" });
    expect(sweep([wayback])).toEqual([wayback.id]);
  });

  it("discards nothing while offline", () => {
    expect(sweep([tab(), tab()], false)).toEqual([]);
  });

  it("treats a tab with no lastAccessed as fresh", () => {
    expect(sweep([tab({ lastAccessed: undefined })])).toEqual([]);
  });

  it("re-evaluates state at sweep time, so an unpinned tab becomes eligible", () => {
    const pinned = tab({ pinned: true });
    expect(sweep([pinned])).toEqual([]);
    // Same tab, now unpinned: no timer had to be re-armed for this to work.
    const unpinned = { ...pinned, pinned: false } as chrome.tabs.Tab;
    expect(sweep([unpinned])).toEqual([unpinned.id]);
  });

  it("handles far more tabs than Chrome's alarm limit", () => {
    // The bug this replaced: one alarm per tab threw past 500 active alarms
    // and silently stopped discarding. A sweep has no per-tab budget at all.
    const many = Array.from({ length: CHROME_ALARM_LIMIT * 3 }, () => tab());
    expect(sweep(many)).toHaveLength(CHROME_ALARM_LIMIT * 3);
  });

  it("returns nothing for an empty tab set", () => {
    expect(sweep([])).toEqual([]);
  });
});

describe("isSpecialDiscardURL", () => {
  it("treats a missing URL as special", () => {
    expect(isSpecialDiscardURL(undefined)).toBe(true);
  });

  it("allows ordinary web pages", () => {
    expect(isSpecialDiscardURL("https://example.com")).toBe(false);
  });

  it("catches the web store on both hosts", () => {
    expect(isSpecialDiscardURL("https://chromewebstore.google.com/x")).toBe(true);
    expect(isSpecialDiscardURL("https://chrome.google.com/webstore/x")).toBe(true);
  });
});

describe("isHostDenylisted", () => {
  it("matches on a host prefix", () => {
    expect(isHostDenylisted("https://archive.ph/x", ["archive."])).toBe(true);
  });

  it("does not match a prefix appearing mid-host", () => {
    expect(isHostDenylisted("https://web.archive.org/x", ["archive."])).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isHostDenylisted("https://ARCHIVE.today/x", ["archive."])).toBe(true);
  });

  it("survives a non-URL", () => {
    expect(isHostDenylisted("not a url", ["archive."])).toBe(false);
    expect(isHostDenylisted(undefined, ["archive."])).toBe(false);
  });
});
