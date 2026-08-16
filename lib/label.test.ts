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
    // Hyphenated identifiers stay whole.
    expect(tokenize("KOALA-6561 shipped 4 times")).toEqual([
      "koala-6561",
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
    const keywords = clusterKeywords(clusters).map((w) => w.join(" "));
    // "tabs" is in every cluster, so it must not survive alone or inside a
    // phrase.
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
    expect(clusterKeywords([cluster])[0].join(" ")).toContain("axolotl");
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
    // "·" separates keywords too, so check for the host itself.
    expect(label).not.toContain("theverge.com");
    expect(label).not.toContain("nytimes.com");
    expect(label).toContain("ceasefire talks");
  });

  it("keeps a phrase together instead of listing its halves", () => {
    const clusters = [
      on("news.local", "ceasefire talks resume", "ceasefire talks continue"),
    ];
    const label = labelClusters(clusters)[0];
    expect(label).toContain("ceasefire talks");
    // Neither half should also appear on its own.
    expect(label.split(" · ")).not.toContain("ceasefire");
    expect(label.split(" · ")).not.toContain("talks");
  });

  it("preserves the casing words were written in", () => {
    const clusters = [
      on("github.com", "KOALA-6561 HDBSCAN rollout", "KOALA-6561 HDBSCAN notes"),
      on("news.local", "unrelated weather report", "unrelated sports report"),
    ];
    expect(labelClusters(clusters)[0]).toContain("KOALA");
    expect(labelClusters(clusters)[0]).toContain("HDBSCAN");
  });

  it("falls back to the site when no keywords survive", () => {
    expect(labelClusters([on("example.com", "the and of")])[0]).toBe("example.com");
  });

  it("falls back to untitled with neither", () => {
    expect(labelClusters([[{ text: "the and", site: null }]])[0]).toBe("untitled");
  });
});
