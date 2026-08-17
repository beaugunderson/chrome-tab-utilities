import { describe, expect, it } from "vitest";
import { hasMetaContent, isRealTitle } from "./features";

describe("isRealTitle", () => {
  it("rejects a site's bare name, however it is cased", () => {
    // x.com serves "X" until its app renders. Treating that as a real title
    // made the harvest report instantly and discard before the post appeared.
    expect(isRealTitle("X", "https://x.com/someone/status/123")).toBe(false);
    expect(isRealTitle("x", "https://x.com/someone/status/123")).toBe(false);
    expect(isRealTitle("GitHub", "https://github.com/o/r")).toBe(false);
    expect(isRealTitle("Reddit", "https://reddit.com/r/x")).toBe(false);
  });

  it("rejects the URL shown in place of a title", () => {
    const url = "https://example.com/a/b";
    expect(isRealTitle(url, url)).toBe(false);
    expect(isRealTitle("example.com/a/b", url)).toBe(false);
  });

  it("rejects a fragment of the URL regardless of case", () => {
    expect(isRealTitle("Status", "https://x.com/someone/status/123")).toBe(false);
  });

  it("accepts a title the page actually set", () => {
    expect(
      isRealTitle('Matt on X: "koji on barley"', "https://x.com/matt/status/1"),
    ).toBe(true);
    expect(isRealTitle("Ceasefire talks resume", "https://news.local/a")).toBe(true);
  });

  it("rejects empty and near-empty titles", () => {
    expect(isRealTitle(undefined, "https://e.com/a")).toBe(false);
    expect(isRealTitle("  ", "https://e.com/a")).toBe(false);
    expect(isRealTitle("ab", "https://e.com/a")).toBe(false);
  });
});

describe("hasMetaContent", () => {
  it("counts a description or a heading", () => {
    expect(hasMetaContent({ description: "Negotiators met again." })).toBe(true);
    expect(hasMetaContent({ heading: "Ceasefire talks resume" })).toBe(true);
  });

  it("does not count properties every page on a site shares", () => {
    // x.com serves og:site_name and nothing else. Counting that as content
    // marked 78 tabs as read, stored their metadata, left them unidentified,
    // and stopped the harvest ever offering them again.
    expect(hasMetaContent({ siteName: "X" })).toBe(false);
    expect(hasMetaContent({ ogType: "article" })).toBe(false);
    expect(hasMetaContent({ section: "World" })).toBe(false);
    expect(hasMetaContent({ siteName: "X", ogType: "article", section: "World" })).toBe(
      false,
    );
  });

  it("ignores whitespace-only values", () => {
    expect(hasMetaContent({ description: "   ", heading: "\n" })).toBe(false);
  });

  it("handles missing metadata", () => {
    expect(hasMetaContent(undefined)).toBe(false);
    expect(hasMetaContent({})).toBe(false);
  });
});
