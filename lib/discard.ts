// Auto-discard eligibility.
//
// One repeating sweep decides what to discard, rather than one alarm per tab:
// Chrome caps an extension at 500 active alarms, and a per-tab scheme throws
// past that and stops discarding anything. A sweep also means every check is
// evaluated against the tab's state right now, so a tab unpinned mid-window is
// immediately discardable.

/** Chrome refuses to create more than this many alarms per extension. */
export const CHROME_ALARM_LIMIT = 500;

export interface DiscardPolicy {
  afterMinutes: number;
  ignorePinned: boolean;
  ignoreAudible: boolean;
  /** Hosts starting with any of these are never discarded. */
  hostPrefixDenylist: string[];
  pauseWhenOffline: boolean;
}

export interface SweepContext {
  now: number;
  online: boolean;
}

export function isSpecialDiscardURL(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url.startsWith("chrome:") ||
    url.startsWith("chrome-extension:") ||
    url.startsWith("chrome-devtools:") ||
    url.startsWith("devtools:") ||
    url.startsWith("edge:") ||
    url.startsWith("about:") ||
    url.startsWith("file:") ||
    url.includes("chromewebstore.google.com") ||
    url.includes("chrome.google.com/webstore")
  );
}

export function isHostDenylisted(
  url: string | undefined,
  prefixes: string[],
): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return prefixes.some((prefix) => host.startsWith(prefix));
}

/**
 * Ids of tabs that have been idle past the window and pass every check that
 * can be made without messaging the page. The caller still has to ask each
 * survivor's content script whether it holds unsaved form input.
 */
export function selectDiscardCandidates(
  tabs: chrome.tabs.Tab[],
  policy: DiscardPolicy,
  { now, online }: SweepContext,
): number[] {
  if (policy.pauseWhenOffline && !online) return [];

  const thresholdMs = policy.afterMinutes * 60 * 1000;
  const out: number[] = [];

  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    if (tab.discarded) continue;
    if (tab.active) continue;
    if (isSpecialDiscardURL(tab.url)) continue;
    if (policy.ignorePinned && tab.pinned) continue;
    if (policy.ignoreAudible && tab.audible) continue;
    if (isHostDenylisted(tab.url, policy.hostPrefixDenylist)) continue;

    // A tab with no lastAccessed has never been reported as accessed, so
    // treat it as fresh rather than discarding it sight unseen.
    if (tab.lastAccessed === undefined) continue;
    if (now - tab.lastAccessed < thresholdMs) continue;

    out.push(tab.id);
  }

  return out;
}
