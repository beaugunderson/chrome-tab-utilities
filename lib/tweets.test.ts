import { describe, expect, it } from "vitest";
import {
  isWorthReading,
  parseEmbedMessage,
  postNeedsReading,
  tweetEmbedUrl,
  tweetHandleFromUrl,
  tweetIdFromUrl,
} from "./tweets";

describe("tweetIdFromUrl", () => {
  it("reads the id from a status URL", () => {
    expect(tweetIdFromUrl("https://x.com/AngelList/status/2080307560591106550")).toBe(
      "2080307560591106550",
    );
    expect(tweetIdFromUrl("https://twitter.com/a/status/123")).toBe("123");
    expect(tweetIdFromUrl("https://mobile.twitter.com/a/statuses/123")).toBe("123");
  });

  it("ignores tracking parameters and sub-paths", () => {
    // Real examples from a live tab set.
    expect(tweetIdFromUrl("https://x.com/a/status/2079674547234574837?s=20")).toBe(
      "2079674547234574837",
    );
    expect(
      tweetIdFromUrl("https://x.com/a/status/2072313022035398795?ref_src=twsrc%5Etfw"),
    ).toBe("2072313022035398795");
    expect(tweetIdFromUrl("https://x.com/a/status/123/photo/1")).toBe("123");
  });

  it("returns null for non-status x.com URLs", () => {
    expect(tweetIdFromUrl("https://x.com/381e35")).toBeNull();
    expect(tweetIdFromUrl("https://x.com/home")).toBeNull();
  });

  it("returns null for other sites and non-URLs", () => {
    expect(tweetIdFromUrl("https://example.com/a/status/123")).toBeNull();
    expect(tweetIdFromUrl("not a url")).toBeNull();
  });
});

describe("tweetHandleFromUrl", () => {
  it("reads the account from any x.com URL", () => {
    expect(tweetHandleFromUrl("https://x.com/AngelList/status/1")).toBe("AngelList");
    expect(tweetHandleFromUrl("https://x.com/_catwu")).toBe("_catwu");
  });

  it("skips x.com's own routes", () => {
    expect(tweetHandleFromUrl("https://x.com/i/bookmarks")).toBeNull();
  });

  it("returns null off-site", () => {
    expect(tweetHandleFromUrl("https://github.com/o/r")).toBeNull();
  });
});

describe("isWorthReading", () => {
  const post = "https://x.com/simonw/status/2073117641020215566";
  const page = "https://dreamsongs.com/Files/whatever.html";

  it("offers a post even after a page load came back empty", () => {
    // The regression: 60 of 64 tabs were hidden from the reader built for them
    // because an older, different method had already failed on them.
    expect(isWorthReading(post, "empty")).toBe(true);
    expect(isWorthReading(post, "timeout")).toBe(true);
  });

  it("does not re-offer an ordinary page proven to have nothing", () => {
    expect(isWorthReading(page, "empty")).toBe(false);
  });

  it("offers anything never tried, or that timed out", () => {
    expect(isWorthReading(page, undefined)).toBe(true);
    expect(isWorthReading(page, "timeout")).toBe(true);
  });

  it("does not re-offer what already worked", () => {
    expect(isWorthReading(page, "text")).toBe(false);
    expect(isWorthReading(page, "title")).toBe(false);
  });
});

describe("postNeedsReading", () => {
  it("reads a post whose page reported a title but not its text", () => {
    // What an x.com tab reports before its app renders the post.
    expect(
      postNeedsReading({
        ogTitle: "Mistral AI (@MistralAI) on X",
        siteName: "X (formerly Twitter)",
        image: "https://abs.twimg.com/generic.png",
      }),
    ).toBe(true);
  });

  it("reads a post nothing is known about", () => {
    expect(postNeedsReading(undefined)).toBe(true);
    expect(postNeedsReading({ siteName: "X (formerly Twitter)" })).toBe(true);
  });

  it("leaves a post whose text is already on record", () => {
    expect(postNeedsReading({ description: "the post itself" })).toBe(false);
  });
});

describe("tweetEmbedUrl", () => {
  it("addresses the embed by post id and theme", () => {
    const url = new URL(tweetEmbedUrl("123", "dark"));
    expect(url.origin).toBe("https://platform.twitter.com");
    expect(url.pathname).toBe("/embed/Tweet.html");
    expect(url.searchParams.get("id")).toBe("123");
    expect(url.searchParams.get("theme")).toBe("dark");
  });
});

describe("parseEmbedMessage", () => {
  const ORIGIN = "https://platform.twitter.com";
  const message = (method: string, params: object) => ({
    "twttr.embed": { jsonrpc: "2.0", method, id: "embed-0", params: [params] },
  });

  it("reads the height an embed asks for", () => {
    expect(
      parseEmbedMessage(
        ORIGIN,
        message("twttr.private.resize", {
          width: 550,
          height: 696,
          data: { tweet_id: "123" },
        }),
      ),
    ).toEqual({ id: "123", kind: "resize", height: 696 });
  });

  it("reads that a post could not be found", () => {
    expect(
      parseEmbedMessage(
        ORIGIN,
        message("twttr.private.no_results", { data: { tweet_id: "1" } }),
      ),
    ).toEqual({ id: "1", kind: "missing" });
  });

  it("ignores the embed's other messages", () => {
    expect(
      parseEmbedMessage(
        ORIGIN,
        message("twttr.private.rendered", { data: { tweet_id: "123" } }),
      ),
    ).toBeNull();
  });

  it("ignores a message from anywhere else", () => {
    expect(
      parseEmbedMessage(
        "https://example.com",
        message("twttr.private.resize", { height: 9999, data: { tweet_id: "123" } }),
      ),
    ).toBeNull();
  });

  it("ignores anything that is not an embed message", () => {
    expect(parseEmbedMessage(ORIGIN, "hello")).toBeNull();
    expect(parseEmbedMessage(ORIGIN, null)).toBeNull();
    expect(parseEmbedMessage(ORIGIN, { "twttr.embed": {} })).toBeNull();
  });
});
