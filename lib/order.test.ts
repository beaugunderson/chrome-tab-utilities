import { describe, expect, it } from "vitest";
import { classifyVisits } from "./engagement";
import { orderTabs, spaceKey } from "./order";

const DAY = 24 * 60 * 60 * 1000;
const tab = (space: string, idleDays: number, days = 1) => ({
  space,
  idleMs: idleDays * DAY,
  engagement: classifyVisits(days),
});

describe("spaceKey", () => {
  it("names the account a post belongs to", () => {
    // 77 x.com tabs are one impossible pile; by account they are a list.
    expect(spaceKey("https://x.com/simonw/status/2081153980294648186", "x.com")).toBe(
      "x.com/simonw",
    );
  });

  it("names the repo, not the page within it", () => {
    expect(spaceKey("https://github.com/canvas-medical/canvas/pull/270", "github.com"))
      .toBe("github.com/canvas-medical");
  });

  it("ignores a segment that names a kind of page", () => {
    expect(spaceKey("https://example.com/blog/why-i-left", "example.com")).toBe(
      "example.com",
    );
    expect(spaceKey("https://example.com/2026/08/a-post", "example.com")).toBe(
      "example.com",
    );
  });

  it("ignores a slug, which is a title rather than a place", () => {
    expect(
      spaceKey("https://fs.blog/an-extremely-long-article-slug-here", "fs.blog"),
    ).toBe("fs.blog");
  });

  it("falls back to the host when there is no path or no host", () => {
    expect(spaceKey("https://fs.blog/", "fs.blog")).toBe("fs.blog");
    expect(spaceKey("not a url", null)).toBe("other");
  });
});

describe("orderTabs", () => {
  it("keeps a space together, biggest space first", () => {
    // A run of pages from one account is where one decision applies several
    // times over, which is the whole reason for ordering at all.
    const order = orderTabs([
      tab("fs.blog", 1),
      tab("x.com/simonw", 2),
      tab("x.com/simonw", 3),
      tab("x.com/simonw", 4),
      tab("news.com", 5),
      tab("news.com", 6),
    ]).map((t) => t.space);

    expect(order).toEqual([
      "x.com/simonw", "x.com/simonw", "x.com/simonw",
      "news.com", "news.com",
      "fs.blog",
    ]);
  });

  it("puts the longest-untouched first within a space", () => {
    const order = orderTabs([
      tab("x.com/simonw", 2),
      tab("x.com/simonw", 40),
      tab("x.com/simonw", 9),
    ]).map((t) => t.idleMs / DAY);

    expect(order).toEqual([40, 9, 2]);
  });

  it("puts the tabs you come back to last, fewest days first", () => {
    // They are the likeliest keeps, and by then the pile is gone.
    const order = orderTabs([
      tab("mail.superhuman.com", 0, 81),
      tab("x.com/simonw", 5),
      tab("calendar.google.com", 0, 4),
    ]).map((t) => t.space);

    expect(order).toEqual([
      "x.com/simonw",
      "calendar.google.com",
      "mail.superhuman.com",
    ]);
  });

  it("breaks a size tie on the space name, so the order never wobbles", () => {
    const first = orderTabs([tab("b.com", 1), tab("a.com", 1)]).map((t) => t.space);
    const again = orderTabs([tab("a.com", 1), tab("b.com", 1)]).map((t) => t.space);
    expect(first).toEqual(["a.com", "b.com"]);
    expect(again).toEqual(first);
  });
});
