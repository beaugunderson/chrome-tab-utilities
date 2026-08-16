import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  featureFingerprint,
  featureText,
  hasMetaContent,
  isRealTitle,
  pathTokens,
} from "./features";

describe("pathTokens", () => {
  it("splits a path into words and drops plumbing segments", () => {
    expect(
      pathTokens("https://github.com/canvas-medical/home-app/pull/4821"),
    ).toEqual(["canvas", "medical", "home", "app", "pull", "4821"]);
  });

  it("drops commit hashes and uuid fragments", () => {
    const tokens = pathTokens(
      "https://github.com/o/r/commit/9f3c1ab27de4f5019a8b2c3d4e5f6071",
    );
    expect(tokens).toContain("commit");
    expect(tokens).not.toContain("9f3c1ab27de4f5019a8b2c3d4e5f6071");
  });

  it("lifts the search terms out of a results page", () => {
    expect(pathTokens("https://www.google.com/search?q=hdbscan+vs+kmeans")).toEqual([
      "search",
      "hdbscan",
      "kmeans",
    ]);
  });

  it("deduplicates repeated segments", () => {
    const tokens = pathTokens("https://example.com/canvas/canvas/canvas");
    expect(tokens).toEqual(["canvas"]);
  });

  it("caps the token count", () => {
    const long = "https://example.com/" + Array.from({ length: 30 }, (_, i) => `word${i}`).join("/");
    expect(pathTokens(long).length).toBeLessThanOrEqual(8);
  });

  it("returns nothing for a URL with no path", () => {
    expect(pathTokens("https://example.com/")).toEqual([]);
  });

  it("survives a non-URL", () => {
    expect(pathTokens("chrome://newtab")).toEqual([]);
    expect(pathTokens(undefined)).toEqual([]);
    expect(pathTokens("not a url")).toEqual([]);
  });
});

describe("featureText", () => {
  it("leads with the title", () => {
    const text = featureText({
      title: "Fix scribe transcript attribution",
      url: "https://github.com/canvas-medical/home-app/pull/4821",
    });
    expect(text.split("\n")[0]).toBe("Fix scribe transcript attribution");
  });

  it("includes harvested metadata", () => {
    const text = featureText({
      title: "Ceasefire talks resume",
      url: "https://www.nytimes.com/2026/08/15/world/talks.html",
      meta: {
        description: "Negotiators met for a third round.",
        siteName: "The New York Times",
        section: "World",
        ogType: "article",
      },
    });
    expect(text).toContain("Negotiators met for a third round.");
    expect(text).toContain("The New York Times");
    expect(text).toContain("World");
    expect(text).toContain("article");
  });

  it("omits og:type website, which says nothing", () => {
    const text = featureText({
      title: "Example",
      url: "https://example.com/",
      meta: { ogType: "website" },
    });
    expect(text).not.toContain("website");
  });

  it("does not repeat a heading identical to the title", () => {
    const text = featureText({
      title: "Ceasefire talks resume",
      url: "https://example.com/a",
      meta: { heading: "ceasefire talks resume" },
    });
    expect(text.match(/ceasefire talks resume/gi)).toHaveLength(1);
  });

  it("falls back to the host when there is no site name", () => {
    const text = featureText({ title: "T", url: "https://www.example.com/a" });
    expect(text).toContain("example.com");
  });

  it("appends tags", () => {
    const text = featureText({
      title: "Listing on 24th",
      url: "https://www.zillow.com/homedetails/123",
      tags: ["house hunting", "ballard"],
    });
    expect(text).toContain("tags: house hunting, ballard");
  });

  it("ignores blank tags", () => {
    const text = featureText({ title: "T", url: "https://e.com/a", tags: ["  "] });
    expect(text).not.toContain("tags:");
  });

  it("handles a tab with nothing but a URL", () => {
    expect(featureText({ url: "https://example.com/widgets" })).toContain("widgets");
  });

  it("returns an empty string for a wholly empty tab", () => {
    expect(featureText({})).toBe("");
  });
});

describe("featureFingerprint", () => {
  it("is stable for identical input", () => {
    const source = { title: "A", url: "https://e.com/a" };
    expect(featureFingerprint(source)).toBe(featureFingerprint({ ...source }));
  });

  it("changes when the title changes", () => {
    expect(featureFingerprint({ title: "A", url: "https://e.com/a" })).not.toBe(
      featureFingerprint({ title: "B", url: "https://e.com/a" }),
    );
  });

  it("changes when tags change, so tagging forces a re-embed", () => {
    const base = { title: "A", url: "https://e.com/a" };
    expect(featureFingerprint(base)).not.toBe(
      featureFingerprint({ ...base, tags: ["work"] }),
    );
  });
});

describe("cleanTitle", () => {
  it("strips a leading unread count", () => {
    expect(cleanTitle("(3) Ceasefire talks resume")).toBe("Ceasefire talks resume");
    expect(cleanTitle("(1,204) Inbox")).toBe("Inbox");
    expect(cleanTitle("[5] Build failed")).toBe("Build failed");
  });

  it("strips a trailing site name matching the host", () => {
    expect(cleanTitle("Rust 2.0 announced | Hacker News", undefined, "news.ycombinator.com")).toBe(
      "Rust 2.0 announced | Hacker News",
    );
    expect(cleanTitle("Some video - YouTube", undefined, "youtube.com")).toBe("Some video");
    expect(cleanTitle("A story · GitHub", undefined, "github.com")).toBe("A story");
  });

  it("strips a trailing site name matching og:site_name", () => {
    expect(cleanTitle("Talks resume — The Verge", "The Verge", "theverge.com")).toBe(
      "Talks resume",
    );
  });

  it("leaves a trailing phrase that is not the site", () => {
    expect(cleanTitle("Pandas - a tutorial", undefined, "example.com")).toBe(
      "Pandas - a tutorial",
    );
  });

  it("never strips the title down to nothing", () => {
    // A title that is only the site name keeps one copy rather than emptying.
    expect(cleanTitle("YouTube - YouTube", undefined, "youtube.com")).toBe("YouTube");
    expect(cleanTitle("Ars - Ars", undefined, "ars.example")).not.toBe("");
    expect(cleanTitle("(3)", undefined, "example.com")).not.toBe("");
  });

  it("handles an empty or missing title", () => {
    expect(cleanTitle(undefined)).toBe("");
    expect(cleanTitle("   ")).toBe("");
  });

  it("feeds the cleaned title into featureText", () => {
    const text = featureText({
      title: "(7) Ceasefire talks resume - The Verge",
      url: "https://www.theverge.com/2026/talks",
      meta: { siteName: "The Verge" },
    });
    expect(text.split("\n")[0]).toBe("Ceasefire talks resume");
  });
});

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
