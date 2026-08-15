import { hostOf } from "./url";

/** Page metadata harvested by the content script, cached per URL. */
export interface PageMeta {
  description?: string;
  siteName?: string;
  section?: string;
  ogType?: string;
  heading?: string;
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

  add(source.title);
  add(meta.heading);
  add(meta.description);
  add(meta.siteName ?? hostOf(source.url) ?? undefined);
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
