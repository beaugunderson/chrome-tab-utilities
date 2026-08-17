// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractReadableText } from "./readable";

const page = (body: string) =>
  `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;

describe("extractReadableText", () => {
  it("prefers the article over the page furniture", () => {
    const html = page(`
      <nav>Home About Contact Subscribe</nav>
      <article><p>Peter Kaufman's talk offers a simple formula for living well.</p></article>
      <footer>Copyright 2026</footer>
    `);
    const text = extractReadableText(html);
    expect(text).toContain("simple formula for living well");
    expect(text).not.toContain("Subscribe");
    expect(text).not.toContain("Copyright");
  });

  it("drops scripts and styles rather than reading them as prose", () => {
    const html = page(`
      <script>var tracking = "should not appear";</script>
      <style>.x { color: red }</style>
      <main><p>The actual words on the page.</p></main>
    `);
    const text = extractReadableText(html);
    expect(text).toBe("The actual words on the page.");
  });

  it("falls back to the body when there is no obvious container", () => {
    expect(extractReadableText(page("<p>Just a bare paragraph.</p>"))).toBe(
      "Just a bare paragraph.",
    );
  });

  it("collapses runs of whitespace and blank lines", () => {
    const text = extractReadableText(page("<main><p>a   b</p>\n\n\n<p>c</p></main>"));
    expect(text).toBe("a b\nc");
  });

  it("truncates with an ellipsis rather than running on", () => {
    const long = "word ".repeat(2000);
    const text = extractReadableText(page(`<main><p>${long}</p></main>`), 100);
    expect(text.length).toBeLessThanOrEqual(101);
    expect(text.endsWith("…")).toBe(true);
  });

  it("survives html that will not parse into anything useful", () => {
    // Malformed input becomes stray text rather than throwing. The length
    // floor in fetchReadableText is what discards it.
    expect(extractReadableText("")).toBe("");
    expect(extractReadableText("<<<").length).toBeLessThan(80);
    expect(() => extractReadableText("<html><body>")).not.toThrow();
  });
});
