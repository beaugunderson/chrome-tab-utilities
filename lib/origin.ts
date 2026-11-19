import { isRealTitle } from "./features";
import { hostOf } from "./url";

// Where a tab was opened from, as one line for the triage card.
//
// "From a search for X" or "from this thread" is frequently the whole
// decision: it says what the tab was for, which its own title cannot. Measured
// on 7,782 stored records: 44% carry an opener, 80% of those openers have a
// title on record, and the commonest opener is a search results page, every
// one of which carries its query.

const MAX_LENGTH = 80;

function shorten(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_LENGTH
    ? `${clean.slice(0, MAX_LENGTH - 1).trimEnd()}…`
    : clean;
}

/** The query of a search results page, or null for any other page. */
function searchQuery(url: URL): string | null {
  const query = url.searchParams.get("q")?.trim();
  if (!query) return null;
  const path = url.pathname;
  // Results pages live at /search (Kagi, Google, Bing) or at the site root
  // (DuckDuckGo). A `q` parameter anywhere else is some page's own business.
  const isResults = path === "/" || path.split("/").includes("search");
  return isResults ? query : null;
}

export function describeOrigin(
  opener: string | undefined,
  openerTitle: string | undefined,
  tabUrl: string,
): string | undefined {
  if (!opener || opener === tabUrl) return undefined;
  let url: URL;
  try {
    url = new URL(opener);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const query = searchQuery(url);
  if (query) return `from a search for “${shorten(query)}”`;

  const host = hostOf(opener) ?? url.hostname;
  return isRealTitle(openerTitle, opener)
    ? `from “${shorten(openerTitle!)}” · ${host}`
    : `from ${host}`;
}
