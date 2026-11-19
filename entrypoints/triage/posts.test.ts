// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { openPostList } from "./posts";
import type { QueueItem } from "./queue";

const post = (id: number, text: string): QueueItem => ({
  id,
  title: text,
  url: `https://x.com/someone/status/${id}`,
  host: "x.com",
  idleDays: 3,
  windowId: 1,
  detail: text,
  byline: "Someone @someone",
});

const handlers = () => ({
  apply: vi.fn(async (): Promise<string | null> => null),
  undo: vi.fn(async () => {}),
  finished: vi.fn(),
});

const press = (key: string) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
/** Lets the awaited apply/undo settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const rows = () => [...document.querySelectorAll<HTMLElement>(".post-row")];
const current = () => rows().findIndex((row) => row.classList.contains("current"));

afterEach(() => {
  press("Escape");
  document.body.innerHTML = "";
});

it("shows every post's text and author at once", () => {
  openPostList([post(1, "first post"), post(2, "second post")], handlers());

  expect(rows().map((row) => row.querySelector(".post-text")?.textContent)).toEqual([
    "first post",
    "second post",
  ]);
  expect(rows()[0].querySelector(".post-author")?.textContent).toBe("Someone @someone");
  expect(current()).toBe(0);
});

it("applies a key to the current row and moves to the next", async () => {
  const items = [post(1, "first"), post(2, "second")];
  const h = handlers();
  openPostList(items, h);

  press("c");
  await settle();

  expect(h.apply).toHaveBeenCalledWith(items[0], "close");
  expect(rows()[0].classList.contains("decided")).toBe(true);
  expect(rows()[0].querySelector(".post-outcome")?.textContent).toBe("Close");
  expect(current()).toBe(1);
});

it("leaves a row undecided when the send fails", async () => {
  const h = handlers();
  h.apply.mockResolvedValueOnce("No Readwise token set");
  openPostList([post(1, "first"), post(2, "second")], h);

  press("r");
  await settle();

  expect(current()).toBe(0);
  expect(rows()[0].classList.contains("decided")).toBe(false);
  expect(document.querySelector(".queue-error")?.textContent).toContain(
    "No Readwise token set",
  );
});

it("moves the cursor without deciding", () => {
  const h = handlers();
  openPostList([post(1, "first"), post(2, "second"), post(3, "third")], h);

  press("j");
  press("j");
  press("k");

  expect(current()).toBe(1);
  expect(h.apply).not.toHaveBeenCalled();
});

it("comes back to rows that were passed over", async () => {
  const items = [post(1, "first"), post(2, "second")];
  const h = handlers();
  openPostList(items, h);

  press("j");
  press("c");
  await settle();

  expect(current()).toBe(0);
  expect(h.finished).not.toHaveBeenCalled();
});

it("undoes the last decision and returns to its row", async () => {
  const items = [post(1, "first"), post(2, "second")];
  const h = handlers();
  openPostList(items, h);

  press("c");
  await settle();
  press("u");
  await settle();

  expect(h.undo).toHaveBeenCalledWith(items[0], "close");
  expect(rows()[0].classList.contains("decided")).toBe(false);
  expect(current()).toBe(0);
});

it("finishes once every post is decided, with the tally", async () => {
  const h = handlers();
  openPostList([post(1, "first"), post(2, "second")], h);

  press("c");
  await settle();
  press(" ");
  await settle();

  expect(h.finished).toHaveBeenCalledWith({
    save: 0,
    task: 0,
    close: 1,
    skip: 1,
    visit: 0,
  });
  expect(rows()).toHaveLength(0);
});

it("moves on to the other view once every post is decided", async () => {
  const h = { ...handlers(), other: { label: "Cards", open: vi.fn() } };
  openPostList([post(1, "first")], h);

  press("c");
  await settle();

  expect(h.other.open).toHaveBeenCalled();
  expect(h.finished).not.toHaveBeenCalled();
});

it("hands over to the other view without finishing", () => {
  const h = { ...handlers(), other: { label: "Cards", open: vi.fn() } };
  openPostList([post(1, "first")], h);

  press("p");

  expect(h.other.open).toHaveBeenCalled();
  expect(h.finished).not.toHaveBeenCalled();
  expect(rows()).toHaveLength(0);
});

const embedSays = (method: string, params: object) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: "https://platform.twitter.com",
      data: { "twttr.embed": { method: `twttr.private.${method}`, params: [params] } },
    }),
  );
const embedOf = (row: HTMLElement) => row.querySelector<HTMLIFrameElement>(".post-embed");

it("shows each post as Twitter's embed, with the recorded text held back", () => {
  openPostList([post(1, "first post"), post(2, "second post")], handlers());

  expect(rows().map((row) => new URL(embedOf(row)!.src).searchParams.get("id"))).toEqual([
    "1",
    "2",
  ]);
  expect(rows()[0].querySelector<HTMLElement>(".post-text")?.hidden).toBe(true);
});

it("gives an embed the height it asks for", () => {
  openPostList([post(1, "first post"), post(2, "second post")], handlers());

  embedSays("resize", { width: 550, height: 696, data: { tweet_id: "2" } });

  expect(embedOf(rows()[1])!.style.height).toBe("696px");
  expect(embedOf(rows()[0])!.style.height).not.toBe("696px");
});

it("falls back to the recorded text when the embed has no post", () => {
  openPostList([post(1, "first post"), post(2, "second post")], handlers());

  embedSays("no_results", { data: { tweet_id: "1" } });

  expect(embedOf(rows()[0])).toBeNull();
  expect(rows()[0].querySelector<HTMLElement>(".post-text")?.hidden).toBe(false);
  expect(embedOf(rows()[1])).not.toBeNull();
});
