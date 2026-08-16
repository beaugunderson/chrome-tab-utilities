import { describe, expect, it } from "vitest";
import { tweetHandleFromUrl, tweetIdFromUrl } from "./tweets";

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
