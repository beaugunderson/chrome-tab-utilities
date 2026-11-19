import { expect, it } from "vitest";
import { describeOrigin } from "./origin";

const TAB = "https://example.com/article";

it("says nothing for a tab with no recorded opener", () => {
  expect(describeOrigin(undefined, undefined, TAB)).toBeUndefined();
});

it("says nothing when the opener is the tab's own address", () => {
  expect(describeOrigin(TAB, "An article", TAB)).toBeUndefined();
});

it("says nothing for an opener that is not a web page", () => {
  expect(
    describeOrigin("chrome-extension://abc/triage.html", "Tab triage", TAB),
  ).toBeUndefined();
  expect(describeOrigin("chrome://newtab/", "New Tab", TAB)).toBeUndefined();
});

it("names the query when the opener is a search", () => {
  expect(
    describeOrigin(
      "https://kagi.com/search?q=declarativeNetRequest+session+rules&r=us",
      "declarativeNetRequest session rules - Kagi Search",
      TAB,
    ),
  ).toBe("from a search for “declarativeNetRequest session rules”");
  expect(
    describeOrigin("https://duckduckgo.com/?q=tab+hoarding&ia=web", undefined, TAB),
  ).toBe("from a search for “tab hoarding”");
  expect(
    describeOrigin("https://www.google.com/search?q=x%20y", undefined, TAB),
  ).toBe("from a search for “x y”");
});

it("names the opener's title and site", () => {
  expect(
    describeOrigin(
      "https://news.ycombinator.com/item?id=1",
      "Show HN: A thing | Hacker News",
      TAB,
    ),
  ).toBe("from “Show HN: A thing | Hacker News” · news.ycombinator.com");
});

it("falls back to the site when the opener's title says nothing", () => {
  expect(describeOrigin("https://x.com/home", "X", TAB)).toBe("from x.com");
  expect(describeOrigin("https://mail.superhuman.com/", undefined, TAB)).toBe(
    "from mail.superhuman.com",
  );
});

it("does not treat a q parameter on an ordinary page as a search", () => {
  expect(
    describeOrigin("https://example.org/docs/page?q=1", "Docs page", TAB),
  ).toBe("from “Docs page” · example.org");
});

it("shortens a long title", () => {
  const origin = describeOrigin("https://example.org/a", "word ".repeat(40), TAB);
  expect(origin!.length).toBeLessThan(110);
  expect(origin).toContain("…");
});
