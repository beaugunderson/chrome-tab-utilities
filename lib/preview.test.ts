import { describe, expect, it } from "vitest";
import { previewFor } from "./preview";

const watch = "https://www.youtube.com/watch?v=_E3Qz7C9KEk";

describe("previewFor", () => {
  it("frames a YouTube watch page as-is while headers are stripped", () => {
    // The watch page plays when framed; only /embed does the origin check
    // that answers Error 153 to a chrome-extension:// embedder.
    expect(previewFor(watch, true)).toBeNull();
  });

  it("falls back to the thumbnail when headers are not stripped", () => {
    expect(previewFor(watch, false)).toMatchObject({
      kind: "image",
      url: "https://i.ytimg.com/vi/_E3Qz7C9KEk/maxresdefault.jpg",
      fallback: "https://i.ytimg.com/vi/_E3Qz7C9KEk/hqdefault.jpg",
    });
  });

  it("recognizes short links, shorts and live as videos", () => {
    for (const url of [
      "https://youtu.be/abc123",
      "https://www.youtube.com/shorts/abc123",
      "https://www.youtube.com/live/abc123",
      "https://m.youtube.com/watch?v=abc123",
      "https://youtu.be/abc123?t=90",
    ]) {
      expect(previewFor(url, false)?.url, url).toBe(
        "https://i.ytimg.com/vi/abc123/maxresdefault.jpg",
      );
    }
  });

  it("frames vimeo's player either way, since it needs no stripping", () => {
    for (const stripping of [true, false]) {
      expect(previewFor("https://vimeo.com/76979871", stripping)).toMatchObject({
        kind: "frame",
        url: "https://player.vimeo.com/video/76979871",
      });
    }
  });

  it("leaves ordinary pages alone", () => {
    expect(previewFor("https://fs.blog/great-talks/thinking/", true)).toBeNull();
    expect(previewFor("https://www.youtube.com/feed/subscriptions", false)).toBeNull();
    expect(previewFor("not a url", false)).toBeNull();
  });
});
