// The page's own words, fetched rather than framed.
//
// A live preview is better when it works, but plenty of sites refuse to be
// framed and some refuse in ways no header rewriting fixes. Fetching the HTML
// and pulling the prose out of it depends on nothing but the page being
// readable, which is the case for the articles and posts that make up most of
// a tab pile.

/** Elements that are furniture rather than content. */
const STRIP = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
];

/** Containers that usually hold the actual article, best first. */
const CONTENT_HINTS = [
  "article",
  "main",
  '[role="main"]',
  ".post-content",
  ".entry-content",
  ".article-body",
  "#content",
];

export const READABLE_LIMIT = 1500;

/**
 * Readable prose from a page's HTML.
 *
 * Deliberately simple: find the densest plausible container, drop the
 * furniture, collapse whitespace. Not a full reader implementation, because
 * the job is only to answer "what is this?" well enough to decide.
 */
export function extractReadableText(html: string, limit = READABLE_LIMIT): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return "";
  }

  for (const selector of STRIP) {
    for (const node of doc.querySelectorAll(selector)) node.remove();
  }

  let best: Element | null = null;
  let bestLength = 0;
  for (const selector of CONTENT_HINTS) {
    for (const candidate of doc.querySelectorAll(selector)) {
      const length = (candidate.textContent ?? "").trim().length;
      if (length > bestLength) {
        best = candidate;
        bestLength = length;
      }
    }
  }

  const source = best ?? doc.body;
  const text = (source?.textContent ?? "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/**
 * Fetch a page and return its prose.
 *
 * Credentials are omitted deliberately: this is a preview, and it should not
 * act as the signed-in user or touch anything behind their session.
 */
export async function fetchReadableText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "follow",
    });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html")) return null;
    const text = extractReadableText(await response.text());
    return text.length >= 80 ? text : null;
  } catch {
    return null;
  }
}
