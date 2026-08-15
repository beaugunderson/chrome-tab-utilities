import { describe, expect, it } from "vitest";
import { featureFingerprint, featureText, pathTokens } from "./features";

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
