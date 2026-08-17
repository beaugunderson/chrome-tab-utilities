// The order cards arrive in.
//
// This is what topic clustering used to do, and the only part of it that was
// earning its keep. Measured on a real 642-tab set, the clusters came out 92%
// single-kind and 450 tabs were simply "a page on the internet", so a cluster
// was rarely something one decision could be made about. What did help was
// adjacency: related tabs arriving consecutively, so the thinking done on one
// carries into the next. A site plus its first path segment gives that, for
// nothing, and works on a tab nobody has ever read.

import type { Engagement } from "./engagement";

export interface OrderedTab {
  /** Site plus first path segment: the account, repo or section. */
  space: string;
  /** Time since this tab was last looked at, for oldest-first within a space. */
  idleMs: number;
  engagement: Engagement;
}

/** Path segments that name a kind of page rather than a place within a site. */
const NOT_A_SPACE = new Set([
  "status", "p", "posts", "post", "article", "articles", "blog", "news",
  "watch", "video", "videos", "item", "items", "page", "pages", "en", "en-us",
  "index", "home", "s", "a", "b", "c", "u", "r", "wiki",
]);

/** A path segment longer than this is a slug or a title, not a place. */
const MAX_SPACE_SEGMENT = 30;

/**
 * Site plus first path segment: the account, repo or section a tab belongs to.
 *
 * This is the one thing a URL reliably says about a page even when nothing has
 * ever read it. 77 undifferentiated x.com tabs are an impossible pile; the
 * same tabs grouped by account are a list of feeds that can be decided about
 * one at a time.
 */
export function spaceKey(url: string, host: string | null): string {
  const site = host ?? "other";
  let segment: string | undefined;
  try {
    segment = new URL(url).pathname.split("/").filter(Boolean)[0];
  } catch {
    return site;
  }
  if (!segment) return site;
  if (NOT_A_SPACE.has(segment.toLowerCase())) return site;
  // Ids and slugs are not places; a handle is short and wordlike.
  if (segment.length > MAX_SPACE_SEGMENT || /^[0-9]+$/.test(segment)) return site;
  return `${site}/${segment}`;
}

/**
 * Tabs in the order they should be decided about.
 *
 * Tabs of one space arrive together, biggest space first, because a run of
 * pages from one account or one repo is where a decision made once applies
 * several times over. Within a space the longest-untouched come first. The
 * tabs you come back to on separate days go last: they are the likeliest
 * keeps, and by the time they arrive the pile in front of them is gone.
 */
export function orderTabs<T extends OrderedTab>(tabs: T[]): T[] {
  const spaces = new Map<string, T[]>();
  const working: T[] = [];
  for (const tab of tabs) {
    if (tab.engagement.returned) {
      working.push(tab);
      continue;
    }
    const group = spaces.get(tab.space);
    if (group) group.push(tab);
    else spaces.set(tab.space, [tab]);
  }

  const bySize = [...spaces.entries()].sort(
    ([keyA, a], [keyB, b]) => b.length - a.length || keyA.localeCompare(keyB),
  );
  return [
    ...bySize.flatMap(([, group]) => [...group].sort((a, b) => b.idleMs - a.idleMs)),
    ...[...working].sort((a, b) => a.engagement.days - b.engagement.days),
  ];
}
