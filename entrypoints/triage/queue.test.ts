// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewFor } from "../../lib/preview";
import { openQueue, type QueueItem } from "./queue";

const item = (url: string): QueueItem => ({
  id: 1,
  title: "a video",
  url,
  host: new URL(url).hostname,
  idleDays: 3,
  windowId: 1,
});

// Framing off, so the video takes the still-image path this file is about.
const handlers = (stripsHeaders = false) => ({
  preview: (url: string) => previewFor(url, stripsHeaders),
  apply: vi.fn(async () => null),
  undo: vi.fn(async () => {}),
  finished: vi.fn(),
});

const frame = () => document.querySelector("iframe.queue-preview") as HTMLIFrameElement;
const image = () => document.querySelector("img.queue-preview") as HTMLImageElement;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the queue preview", () => {
  it("frames a video's own page when the framing rule is in force", () => {
    openQueue([item("https://www.youtube.com/watch?v=_E3Qz7C9KEk")], handlers(true));

    expect(frame().hidden).toBe(false);
    expect(frame().src).toBe("https://www.youtube.com/watch?v=_E3Qz7C9KEk");
    expect(image().hidden).toBe(true);
  });

  it("shows a still frame for a video when framing is unavailable", () => {
    openQueue([item("https://www.youtube.com/watch?v=_E3Qz7C9KEk")], handlers());

    expect(image().hidden).toBe(false);
    expect(image().src).toBe("https://i.ytimg.com/vi/_E3Qz7C9KEk/maxresdefault.jpg");
    // An iframe here would render YouTube's "Error 153" rather than the video.
    expect(frame().hidden).toBe(true);
    expect(document.querySelector(".queue-preview-note")?.textContent).toContain(
      "thumbnail",
    );
  });

  it("falls back to the thumbnail every video has", () => {
    openQueue([item("https://youtu.be/abc123")], handlers());

    image().dispatchEvent(new Event("error"));

    expect(image().src).toBe("https://i.ytimg.com/vi/abc123/hqdefault.jpg");
  });

  it("frames an ordinary page at its own address", () => {
    openQueue([item("https://fs.blog/great-talks/thinking/")], handlers());

    expect(frame().hidden).toBe(false);
    expect(frame().src).toBe("https://fs.blog/great-talks/thinking/");
    expect(image().hidden).toBe(true);
  });

  it("shows the page's own image once the browser refuses to frame it", () => {
    // A refused frame renders as a grey box that reads like a slow load, and
    // the iframe's load event fires for it exactly as for a working page.
    const still = {
      kind: "image" as const,
      url: "https://pbs.twimg.com/media/abc.jpg",
      note: "Showing the page's own image.",
    };
    const handle = openQueue([item("https://x.com/simonw/status/1")], {
      ...handlers(true),
      preview: (_url, stripsHeaders) => (stripsHeaders ? null : still),
    });
    expect(frame().hidden).toBe(false);

    handle.previewBlocked("https://x.com/simonw/status/1");

    expect(image().hidden).toBe(false);
    expect(image().src).toBe(still.url);
    expect(frame().hidden).toBe(true);
  });

  it("says which site refused when it has nothing to show instead", () => {
    const handle = openQueue([item("https://fs.blog/great-talks/")], handlers(true));

    handle.previewBlocked("https://fs.blog/great-talks/");

    expect(frame().hidden).toBe(true);
    expect(image().hidden).toBe(true);
    expect(document.querySelector(".queue-preview-note")?.textContent).toBe(
      "fs.blog refused to be framed.",
    );
  });

  it("ignores a refusal that belongs to a card already moved past", () => {
    const handle = openQueue([item("https://fs.blog/one/")], handlers(true));

    handle.previewBlocked("https://example.com/something-else");

    expect(frame().hidden).toBe(false);
    expect(document.querySelector<HTMLElement>(".queue-preview-note")?.hidden).toBe(true);
  });

  it("offers no preview for a page that is not on the web", () => {
    openQueue([item("chrome://extensions/")], handlers());

    expect(frame().hidden).toBe(true);
    expect(image().hidden).toBe(true);
    expect(document.querySelector(".queue-preview-note")?.textContent).toContain(
      "No preview",
    );
  });
});
