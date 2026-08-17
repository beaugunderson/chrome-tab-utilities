import { describe, expect, it } from "vitest";
import { embeddableUrl } from "./embeddable";

describe("embeddableUrl", () => {
  it("rewrites a watch page to the player", () => {
    // /watch sends x-frame-options: SAMEORIGIN; /embed sends none.
    expect(embeddableUrl("https://www.youtube.com/watch?v=_E3Qz7C9KEk")?.url).toBe(
      "https://www.youtube.com/embed/_E3Qz7C9KEk",
    );
  });

  it("handles short links, shorts and live", () => {
    expect(embeddableUrl("https://youtu.be/abc123")?.url).toBe(
      "https://www.youtube.com/embed/abc123",
    );
    expect(embeddableUrl("https://www.youtube.com/shorts/abc123")?.url).toBe(
      "https://www.youtube.com/embed/abc123",
    );
    expect(embeddableUrl("https://m.youtube.com/watch?v=abc123")?.url).toBe(
      "https://www.youtube.com/embed/abc123",
    );
  });

  it("keeps the timestamp, in either notation", () => {
    expect(embeddableUrl("https://youtu.be/abc?t=90")?.url).toContain("start=90");
    expect(embeddableUrl("https://www.youtube.com/watch?v=abc&t=1h2m3s")?.url).toContain(
      "start=3723",
    );
  });

  it("ignores a timestamp it cannot read", () => {
    expect(embeddableUrl("https://youtu.be/abc?t=soon")?.url).toBe(
      "https://www.youtube.com/embed/abc",
    );
  });

  it("rewrites vimeo to its player", () => {
    expect(embeddableUrl("https://vimeo.com/76979871")?.url).toBe(
      "https://player.vimeo.com/video/76979871",
    );
  });

  it("leaves ordinary pages alone", () => {
    expect(embeddableUrl("https://fs.blog/great-talks/thinking/")).toBeNull();
    expect(embeddableUrl("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(embeddableUrl("not a url")).toBeNull();
  });
});
