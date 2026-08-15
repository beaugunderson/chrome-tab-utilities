import { describe, expect, it } from "vitest";
import {
  type LabelSource,
  clusterKeywords,
  dominantSite,
  labelClusters,
  tokenize,
} from "./label";

function on(site: string, ...titles: string[]): LabelSource[] {
  return titles.map((text) => ({ text, site }));
}

describe("tokenize", () => {
  it("drops stopwords and short tokens", () => {
    expect(tokenize("The state of the art in AI")).toEqual(["state", "art"]);
  });

  it("keeps technical tokens containing + and #", () => {
    expect(tokenize("C++ and C# benchmarks")).toEqual(["c++", "c#", "benchmarks"]);
  });

  it("keeps ticket-sized numbers, drops short ones", () => {
    expect(tokenize("KOALA-6561 shipped 4 times")).toEqual([
      "koala",
      "6561",
      "shipped",
      "times",
    ]);
  });
});

describe("clusterKeywords", () => {
  it("picks the distinctive term, not the one every cluster shares", () => {
    // "tabs" appears in all three clusters, so it must not win any label.
    const clusters = [
      on("github.com", "tabs clustering embeddings", "tabs embeddings model"),
      on("nytimes.com", "tabs ceasefire talks", "tabs ceasefire summit"),
      on("zillow.com", "tabs ballard listing", "tabs ballard house"),
    ];
    const keywords = clusterKeywords(clusters);
    for (const words of keywords) expect(words).not.toContain("tabs");
    expect(keywords[0]).toContain("embeddings");
    expect(keywords[1]).toContain("ceasefire");
    expect(keywords[2]).toContain("ballard");
  });

  it("ignores terms appearing once in a large cluster", () => {
    const cluster = on(
      "example.com",
      "review pull request",
      "review pull request",
      "review pull request",
      "unrelated axolotl trivia",
    );
    expect(clusterKeywords([cluster])[0]).not.toContain("axolotl");
  });

  it("still labels a small cluster from single mentions", () => {
    const cluster = on("example.com", "axolotl husbandry");
    expect(clusterKeywords([cluster])[0]).toContain("axolotl");
  });

  it("returns an empty list for a contentless cluster", () => {
    expect(clusterKeywords([on("example.com", "the and of")])[0]).toEqual([]);
  });

  it("is deterministic when scores tie", () => {
    const clusters = [on("example.com", "alpha beta gamma")];
    expect(clusterKeywords(clusters)).toEqual(clusterKeywords(clusters));
  });
});

describe("dominantSite", () => {
  it("names a site holding most of the cluster", () => {
    const cluster = [
      ...on("github.com", "a", "b", "c"),
      ...on("nytimes.com", "d"),
    ];
    expect(dominantSite(cluster)).toBe("github.com");
  });

  it("returns null for a mixed cluster", () => {
    const cluster = [
      ...on("github.com", "a", "b"),
      ...on("nytimes.com", "c", "d"),
    ];
    expect(dominantSite(cluster)).toBeNull();
  });

  it("returns null for an empty cluster", () => {
    expect(dominantSite([])).toBeNull();
  });
});

describe("labelClusters", () => {
  it("prefixes single-site clusters with the host", () => {
    const clusters = [
      on("github.com", "pull request review", "pull request review"),
      on("nytimes.com", "ceasefire talks", "ceasefire summit"),
    ];
    const [first] = labelClusters(clusters);
    expect(first.startsWith("github.com · ")).toBe(true);
  });

  it("omits the prefix for mixed-site clusters", () => {
    const clusters = [
      [
        ...on("theverge.com", "ceasefire talks resume"),
        ...on("nytimes.com", "ceasefire talks continue"),
      ],
    ];
    const label = labelClusters(clusters)[0];
    expect(label).not.toContain("·");
    expect(label).toContain("ceasefire");
    expect(label).toContain("talks");
  });

  it("falls back to the site when no keywords survive", () => {
    expect(labelClusters([on("example.com", "the and of")])[0]).toBe("example.com");
  });

  it("falls back to untitled with neither", () => {
    expect(labelClusters([[{ text: "the and", site: null }]])[0]).toBe("untitled");
  });
});
