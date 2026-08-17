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
  /** og:image, shown when the page itself refuses to be framed. */
  image?: string;
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
