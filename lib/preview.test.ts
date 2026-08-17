import { describe, expect, it } from "vitest";
import { previewFor } from "./preview";

describe("previewFor", () => {
  it("gives a YouTube video its thumbnail, not a player", () => {
    // The player answers Error 153 to any chrome-extension:// embedder.
    expect(previewFor("https://www.youtube.com/watch?v=_E3Qz7C9KEk")).toMatchObject({
      kind: "image",
      url: "https://i.ytimg.com/vi/_E3Qz7C9KEk/maxresdefault.jpg",
      fallback: "https://i.ytimg.com/vi/_E3Qz7C9KEk/hqdefault.jpg",
    });
  });

  it("handles short links, shorts and live", () => {
    for (const url of [
      "https://youtu.be/abc123",
      "https://www.youtube.com/shorts/abc123",
      "https://www.youtube.com/live/abc123",
      "https://m.youtube.com/watch?v=abc123",
    ]) {
      expect(previewFor(url)?.url, url).toBe(
        "https://i.ytimg.com/vi/abc123/maxresdefault.jpg",
      );
    }
  });

  it("ignores a timestamp, which a still frame has no use for", () => {
    expect(previewFor("https://youtu.be/abc?t=90")?.url).toBe(
      "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
    );
  });

  it("frames vimeo's player, which embeds from an extension page", () => {
    expect(previewFor("https://vimeo.com/76979871")).toMatchObject({
      kind: "frame",
      url: "https://player.vimeo.com/video/76979871",
    });
  });

  it("leaves ordinary pages alone", () => {
    expect(previewFor("https://fs.blog/great-talks/thinking/")).toBeNull();
    expect(previewFor("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(previewFor("not a url")).toBeNull();
  });
});
