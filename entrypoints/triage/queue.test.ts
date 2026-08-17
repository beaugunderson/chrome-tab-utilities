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

const handlers = () => ({
  preview: previewFor,
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
  it("shows a still frame for a video that refuses to be framed", () => {
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

  it("offers no preview for a page that is not on the web", () => {
    openQueue([item("chrome://extensions/")], handlers());

    expect(frame().hidden).toBe(true);
    expect(image().hidden).toBe(true);
    expect(document.querySelector(".queue-preview-note")?.textContent).toContain(
      "No preview",
    );
  });
});
