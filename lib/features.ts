import { hostOf } from "./url";

/** Page metadata harvested by the content script, cached per URL. */
export interface PageMeta {
  description?: string;
  /** og:title or twitter:title: server-rendered, so it survives an app that never runs. */
  ogTitle?: string;
  siteName?: string;
  section?: string;
  ogType?: string;
  heading?: string;
}

/**
 * Whether a title says more than the address already does.
 *
 * Deliberately strict about the site's bare name. x.com serves a title of "X"
 * until its app renders, and a lenient check treated that as a real title, so
 * the harvest reported instantly with "X" and the tab was discarded before the
 * post ever appeared. Case-insensitive throughout for the same reason: "X" is
 * not absent from "x.com" in any sense that matters.
 */
export function isRealTitle(title: string | undefined, url: string): boolean {
  const trimmed = (title ?? "").trim();
  if (trimmed.length < 3) return false;

  const lower = trimmed.toLowerCase();
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes(lower)) return false;

  // "X", "GitHub", "Reddit": the site's name is not a page's title.
  const host = hostOf(url)?.toLowerCase() ?? "";
  const compact = (v: string) => v.replace(/[^a-z0-9]/g, "");
  const sld = host.split(".")[0] ?? "";
  return compact(lower) !== compact(host) && compact(lower) !== compact(sld);
}

/**
 * Whether harvested metadata says anything about *this page*.
 *
 * A description, a heading or an og:title counts. A site name, an og:type and
 * a section are properties of the site: every page on it carries the same
 * ones, so they cannot distinguish one page from another.
 *
 * This has to be the single definition. It was briefly two — one that counted
 * a site name and one that did not — and x.com, which serves og:site_name and
 * nothing else, fell straight into the gap: 78 tabs were reported as read,
 * their metadata was stored, and they stayed unidentified, with the stored
 * metadata making the harvest skip them ever after.
 */
export function hasMetaContent(meta: PageMeta | undefined): boolean {
  if (!meta) return false;
  return Boolean(
    meta.description?.trim() || meta.heading?.trim() || meta.ogTitle?.trim(),
  );
}

export interface FeatureSource {
  title?: string;
  url?: string;
  meta?: PageMeta;
  tags?: string[];
}

// Path segments that describe the site's plumbing rather than the page.
const PATH_NOISE = new Set([
  "www", "index", "html", "htm", "php", "aspx", "page", "pages", "en", "us",
  "en-us", "amp", "default", "home", "view", "article", "articles", "post",
  "posts", "blog", "docs", "doc", "app", "web", "content", "id", "item",
]);

const MAX_PATH_TOKENS = 8;

// Query parameters that carry what the user actually asked for. A search
// results tab is otherwise almost contentless.
const QUERY_KEYS = ["q", "query", "search", "search_query", "k", "text"];

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/**
 * Path segments worth embedding: real words, not ids, hashes or file
 * extensions. `/canvas-medical/home-app/pull/4821` yields canvas, medical,
 * home, app, pull.
 */
export function pathTokens(url: string | undefined): string[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const token = raw.toLowerCase();
    if (token.length < 3) return;
    // Commit hashes, uuid fragments and yyyymmdd stamps: no semantic content.
    // Shorter digit runs are kept, since they are usually PR or ticket numbers.
    if (/^[0-9a-f]{8,}$/.test(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  for (const segment of parsed.pathname.split("/")) {
    if (!segment) continue;
    // The noise list matches whole segments only. A bare /home/ is plumbing,
    // but the "home" in a home-app repo name is part of its name.
    if (PATH_NOISE.has(segment.toLowerCase())) continue;
    for (const token of segment.split(TOKEN_SPLIT)) {
      if (token) push(token);
    }
    if (out.length >= MAX_PATH_TOKENS) break;
  }

  for (const key of QUERY_KEYS) {
    const value = parsed.searchParams.get(key);
    if (!value) continue;
    for (const token of value.split(TOKEN_SPLIT)) {
      if (token) push(token);
    }
  }

  return out.slice(0, MAX_PATH_TOKENS);
}

const TITLE_SEPARATORS = ["|", "–", "—", "·", "»", "::", " - "];

/**
 * Strip the parts of a tab title that describe the browser rather than the
 * page: unread counts, and the site name every title from that host repeats.
 * Both make unrelated tabs on one site look alike, and both crowd out the few
 * words that actually say what the page is.
 */
export function cleanTitle(
  title: string | undefined,
  siteName?: string,
  host?: string | null,
): string {
  let out = (title ?? "").trim();
  if (!out) return "";

  // "(3) name", "(1,204) name", "[5] name". Kept as-is when the count is the
  // entire title, which happens on pages that never set one.
  const withoutCount = out.replace(/^[([]\s*[\d,.]+\+?\s*[)\]]\s*/, "").trim();
  if (withoutCount) out = withoutCount;

  // A trailing site name, however it was separated. Compared loosely, since
  // "The New York Times" appears as "nytimes.com" in the host.
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = [siteName, host, host?.replace(/\.[a-z.]+$/, "")]
    .filter((v): v is string => Boolean(v))
    .map(compact)
    .filter((v) => v.length >= 3);

  for (const separator of TITLE_SEPARATORS) {
    const at = out.lastIndexOf(separator);
    if (at <= 0) continue;
    const tail = out.slice(at + separator.length).trim();
    if (!tail) continue;
    const tailKey = compact(tail);
    if (tailKey.length < 3) continue;
    if (!names.some((name) => name === tailKey || name.includes(tailKey))) continue;
    const head = out.slice(0, at).trim();
    // Never strip away the whole title.
    if (head.length >= 3) out = head;
    break;
  }

  return out;
}

/**
 * The text handed to the embedding model. Ordered most to least specific,
 * because the model truncates at 256 tokens and the title matters most.
 */
export function featureText(source: FeatureSource): string {
  const meta = source.meta ?? {};
  const lines: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined) => {
    const text = value?.trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(text);
  };

  const host = hostOf(source.url);
  add(cleanTitle(source.title, meta.siteName, host));
  // Often the only thing a JS app exposes about itself.
  add(meta.ogTitle);
  add(meta.heading);
  add(meta.description);
  add(meta.siteName ?? host ?? undefined);
  add(meta.section);
  // og:type alone ("article", "product") is only useful next to the section.
  if (meta.ogType && meta.ogType !== "website") add(meta.ogType);

  const tokens = pathTokens(source.url);
  if (tokens.length > 0) add(tokens.join(" "));

  const tags = source.tags?.filter((t) => t.trim().length > 0) ?? [];
  if (tags.length > 0) lines.push(`tags: ${tags.join(", ")}`);

  return lines.join("\n");
}

/**
 * Short hash of the feature text, stored beside a cached vector so a tab whose
 * title or tags changed gets re-embedded while everything else stays cached.
 */
export function featureFingerprint(source: FeatureSource): string {
  const text = featureText(source);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
