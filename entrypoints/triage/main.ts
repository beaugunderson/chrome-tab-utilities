// Tab triage: one tab at a time.
//
// The page is the queue. It gathers what is known about every unpinned tab,
// puts them in an order, and deals them one card at a time.
//
// There is no topic clustering. It was tried and measured: on a real 642-tab
// set the clusters came out 92% single-kind and 450 of the tabs were simply "a
// page on the internet", so the groups did not encode anything a single
// decision could be made about, while the model producing them cost 47MB of
// runtime and a download before the first card could be dealt. Ordering by
// site and section does the one thing the clustering really provided: related
// tabs arrive consecutively, so the thinking done on one carries into the next.

import { type PageMeta, hasMetaContent } from "../../lib/features";
import {
  type TabRecord,
  loadRecords,
  pruneStore,
  saveRecords,
} from "../../lib/store";
import { removeTabs } from "../../lib/tabs";
import {
  fetchTweet,
  postNeedsReading,
  tweetHandleFromUrl,
  tweetIdFromUrl,
} from "../../lib/tweets";
import {
  type Engagement,
  classifyVisits,
  describeEngagement,
  fetchEngagement,
  fetchSweepTimes,
} from "../../lib/engagement";
import {
  allowFramingInTab,
  stopAllowingFraming,
  watchBlockedFrames,
} from "../../lib/framing";
import { type Preview, previewFor } from "../../lib/preview";
import { fetchReadableText } from "../../lib/readable";
import { readwiseRequest, send, todoistRequest } from "../../lib/outbox";
import { readTokens } from "../../lib/tokens";
import { openPostList } from "./posts";
import {
  type Disposition,
  type QueueHandle,
  type QueueItem,
  emptyCounts,
  openQueue,
} from "./queue";
import { orderTabs, spaceKey, type OrderedTab } from "../../lib/order";
import { describeOrigin } from "../../lib/origin";
import { hostOf } from "../../lib/url";

/** Page-metadata requests in flight while backfilling. */
const META_CONCURRENCY = 16;
/** Post lookups are a small JSON request each, so they can run wider. */
const TWEET_CONCURRENCY = 6;
/** Which card is showing, kept in the URL so a reload resumes there. */
const RESUME_PARAM = "tab";
/** Which view is showing, kept in the URL for the same reason. */
const VIEW_PARAM = "view";
const CARDS_VIEW = "cards";

const DAY_MS = 24 * 60 * 60 * 1000;

interface TriageTab extends OrderedTab {
  id: number;
  windowId: number;
  title: string;
  url: string;
  host: string | null;
  meta?: PageMeta;
  /** Where the tab was opened from, when that was recorded. */
  origin?: string;
}

let records = new Map<string, TabRecord>();
let unwatch: (() => void) | undefined;

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// ===== Loading =====

function setProgress(label: string, fraction: number | null, note = "") {
  el("progress").hidden = false;
  el("progress-label").textContent = label;
  el("progress-note").textContent = note;
  const bar = el("progress-bar");
  bar.style.width = fraction === null ? "100%" : `${Math.round(fraction * 100)}%`;
  bar.classList.toggle("indeterminate", fraction === null);
}

function hideProgress() {
  el("progress").hidden = true;
}

/** Empty tabs carry nothing to decide about. */
function isBlankTab(url: string): boolean {
  return (
    url === "about:blank" ||
    url === "chrome://newtab/" ||
    url === "chrome://new-tab-page/" ||
    url.startsWith("chrome://newtab")
  );
}

async function collectTabs(): Promise<chrome.tabs.Tab[]> {
  const selfUrl = chrome.runtime.getURL("triage.html");
  const all = await chrome.tabs.query({});
  return all.filter(
    (t) =>
      t.id !== undefined &&
      t.url &&
      !t.url.startsWith(selfUrl) &&
      !isBlankTab(t.url) &&
      // Pinned tabs are deliberate keeps, so they stay out of a closure tool.
      !t.pinned,
  );
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/**
 * Ask each loaded tab's content script for its page metadata directly.
 *
 * The content script only reports on page load, so a tab open since before the
 * extension was installed has none cached. Discarded tabs have no content
 * script and are skipped; they keep whatever was cached when last loaded, and
 * the card fetches their text at decision time regardless.
 */
async function backfillMeta(tabs: chrome.tabs.Tab[]): Promise<number> {
  const missing = tabs.filter(
    (t) =>
      !t.discarded &&
      t.status === "complete" &&
      // Metadata that is only a site name does not count as read.
      !hasMetaContent(records.get(t.url!)?.meta),
  );
  if (missing.length === 0) return 0;

  setProgress("Reading page metadata…", 0, `${missing.length} tabs`);
  const updates = new Map<string, TabRecord>();
  let done = 0;

  await mapWithConcurrency(missing, META_CONCURRENCY, async (tab) => {
    try {
      const response = (await chrome.tabs.sendMessage(tab.id!, {
        type: "get-page-meta",
      })) as { meta?: PageMeta } | undefined;
      // Site name and og:type alone are not content; storing them would mark
      // the page read and stop it ever being offered again.
      if (hasMetaContent(response?.meta)) {
        const record = { ...(records.get(tab.url!) ?? {}), meta: response!.meta };
        records.set(tab.url!, record);
        updates.set(tab.url!, record);
      }
    } catch {
      // No content script here (chrome://, the web store, a tab mid-load).
    }
    done++;
    setProgress(
      `Reading page metadata… ${done}/${missing.length}`,
      done / missing.length,
    );
  });

  await saveRecords(updates);
  return updates.size;
}

/**
 * Read x.com posts from Twitter's syndication endpoint rather than loading
 * them.
 *
 * Measured on 53 real tabs: x.com's served HTML carries viewport, fb:app_id,
 * og:site_name and three site-verification tokens, and nothing else. No title,
 * no description, nothing per-post, and the app never hydrates in a background
 * tab, so there is nothing in the page to read however long you wait. The
 * endpoint returns the post text and its photo as JSON without authentication,
 * one small request per post.
 */
async function readPosts(tabs: chrome.tabs.Tab[]): Promise<number> {
  const targets = tabs.filter(
    (t) => tweetIdFromUrl(t.url!) && postNeedsReading(records.get(t.url!)?.meta),
  );
  if (targets.length === 0) return 0;

  setProgress("Reading posts…", 0, `${targets.length} posts`);
  const updates = new Map<string, TabRecord>();
  let read = 0;
  let done = 0;

  await mapWithConcurrency(targets, TWEET_CONCURRENCY, async (tab) => {
    const tweet = await fetchTweet(tweetIdFromUrl(tab.url!)!);
    if (tweet) {
      const record: TabRecord = {
        ...(records.get(tab.url!) ?? {}),
        meta: {
          ...records.get(tab.url!)?.meta,
          description: tweet.text.slice(0, 400),
          siteName: tweet.author ? `${tweet.author} on X` : "X",
          image: tweet.image,
        },
      };
      records.set(tab.url!, record);
      updates.set(tab.url!, record);
      read++;
    }
    setProgress(`Reading posts… ${++done}/${targets.length}`, done / targets.length);
  });

  await saveRecords(updates);
  return read;
}

// ===== Running =====

function idleDays(tab: TriageTab): number {
  return tab.idleMs === Number.POSITIVE_INFINITY ? 999 : tab.idleMs / DAY_MS;
}

async function run() {
  setProgress("Reading tabs…", null);
  const raw = await collectTabs();
  if (raw.length === 0) {
    finish("Nothing to triage", "Every unpinned tab has been dealt with.");
    return;
  }

  const urls = raw.map((t) => t.url!);
  records = await loadRecords(urls);
  // The pages these tabs were opened from, which are mostly not open tabs
  // themselves, so their titles come from the store.
  const openers = await loadRecords([
    ...new Set(
      [...records.values()].flatMap((r) => (r.opener ? [r.opener] : [])),
    ),
  ]);

  await backfillMeta(raw);
  await readPosts(raw);

  setProgress("Reading visit history…", null);
  const engagements = await fetchEngagement(urls, await fetchSweepTimes());

  const now = Date.now();
  const tabs: TriageTab[] = raw.map((t) => {
    const url = t.url!;
    const record = records.get(url);
    // lastAccessed resets on browser restart, so fall back to the snapshot the
    // background keeps per URL, whichever is more recent.
    const lastSeen = Math.max(t.lastAccessed ?? 0, record?.seen ?? 0);
    const host = hostOf(url);
    return {
      id: t.id!,
      windowId: t.windowId!,
      title: bestTitle(t.title, record, url),
      url,
      host,
      space: spaceKey(url, host),
      idleMs: lastSeen > 0 ? now - lastSeen : Number.POSITIVE_INFINITY,
      engagement: engagements.get(url) ?? classifyVisits(0, 0),
      meta: record?.meta,
      origin: describeOrigin(
        record?.opener,
        record?.opener
          ? bestTitle(undefined, openers.get(record.opener), "")
          : undefined,
        url,
      ),
    };
  });

  const working = tabs.filter((t) => t.engagement.returned).length;
  el("stats").textContent =
    `${tabs.length} tabs · ${new Set(tabs.map((t) => t.space)).size} spaces · ` +
    `${working} you come back to`;

  void pruneStore();
  await startQueue(orderTabs(tabs));
}

/**
 * What to call a tab.
 *
 * Chrome shows the URL where the title would be for a tab it never loaded, and
 * a title a JS app sets does not survive the tab being discarded a moment
 * later, so the copy the page itself reported is the dependable one.
 */
function bestTitle(
  chromeTitle: string | undefined,
  record: TabRecord | undefined,
  url: string,
): string {
  return (
    record?.meta?.ogTitle?.trim() ||
    record?.title?.trim() ||
    chromeTitle?.trim() ||
    url
  );
}

// ===== One at a time =====

function toItem(tab: TriageTab, spaceSize: number): QueueItem {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    host: tab.host,
    idleDays: Math.round(idleDays(tab)),
    detail: tab.meta?.description ?? tab.meta?.heading,
    engagement: describeEngagement(tab.engagement, idleDays(tab)),
    origin: tab.origin,
    group: spaceSize > 1 ? `${tab.space} · ${spaceSize} tabs` : tab.space,
    ...(tweetIdFromUrl(tab.url) ? { byline: postByline(tab), image: tab.meta?.image } : {}),
  };
}

/** "Simon Willison @simonw", from what the post lookup stored and the URL. */
function postByline(tab: TriageTab): string {
  const handle = tweetHandleFromUrl(tab.url);
  const name = tab.meta?.siteName?.replace(/ on X$/, "");
  return [name && name !== "X" ? name : null, handle ? `@${handle}` : null]
    .filter(Boolean)
    .join(" ");
}

async function applyDisposition(
  item: QueueItem,
  disposition: Disposition,
): Promise<string | null> {
  if (disposition === "skip") return null;

  // Going to the tab leaves it open: the point is to look at it properly, and
  // whatever happens next happens there.
  if (disposition === "visit") {
    await chrome.tabs.update(item.id, { active: true });
    await chrome.windows.update(item.windowId, { focused: true });
    return null;
  }

  if (disposition !== "close") {
    const tokens = await readTokens();
    const token = disposition === "save" ? tokens.readwise : tokens.todoist;
    const service = disposition === "save" ? "Readwise" : "Todoist";
    if (!token) return `No ${service} token set — add one on the options page`;

    const request =
      disposition === "save"
        ? readwiseRequest(token, { url: item.url, title: item.title })
        : todoistRequest(token, { url: item.url, title: item.title });
    const result = await send(request);
    // The tab stays open on failure. Closing it would lose the thing the
    // disposition was meant to preserve.
    if (!result.ok) return result.error ?? "request failed";
  }

  await removeTabs([item.id]);
  return null;
}

/** The card to open on, from the URL, so a reload lands where it left off. */
function resumeIndex(items: QueueItem[]): number {
  const wanted = new URLSearchParams(location.search).get(RESUME_PARAM);
  if (!wanted) return 0;
  const at = items.findIndex((item) => String(item.id) === wanted);
  // A tab dealt with before the reload is gone from the list, and its position
  // means nothing in an order that has since changed, so start over.
  return at === -1 ? 0 : at;
}

function rememberPlace(item: QueueItem | null) {
  const url = new URL(location.href);
  if (item) url.searchParams.set(RESUME_PARAM, String(item.id));
  else url.searchParams.delete(RESUME_PARAM);
  history.replaceState(null, "", url);
}

/** Posts open as the list unless the URL says the cards were showing. */
function rememberView(cards: boolean) {
  const url = new URL(location.href);
  if (cards) url.searchParams.set(VIEW_PARAM, CARDS_VIEW);
  else url.searchParams.delete(VIEW_PARAM);
  history.replaceState(null, "", url);
}

async function startQueue(tabs: TriageTab[]) {
  const sizes = new Map<string, number>();
  for (const tab of tabs) sizes.set(tab.space, (sizes.get(tab.space) ?? 0) + 1);
  const items = tabs.map((tab) => toItem(tab, sizes.get(tab.space) ?? 1));
  if (items.length === 0) {
    finish("Nothing to triage", "Every unpinned tab has been dealt with.");
    return;
  }

  // Let the preview frame load pages that would otherwise refuse to be framed,
  // for this tab only and only while the queue is open. Best effort: a queue
  // without previews is still a working queue, and this failing silently once
  // stopped the button doing anything at all.
  let framing = false;
  let tabId: number | undefined;
  try {
    const self = await chrome.tabs.getCurrent();
    if (self?.id === undefined) throw new Error("no tab id for this page");
    tabId = self.id;
    // Chrome exposes this namespace only to an instance whose manifest asked
    // for it, and an unpacked extension keeps running the manifest it was
    // loaded with. So an instance loaded before the permission existed reports
    // the API as undefined until it is reloaded, and every preview fails.
    if (!chrome.declarativeNetRequest) {
      throw new Error(
        "this instance predates the framing permission — reload the extension",
      );
    }
    // declarativeNetRequestWithHostAccess strips headers only for sites the
    // extension can reach, and Chrome lets that access be narrowed to "on
    // click" per site. Withheld access looks exactly like a site refusing to
    // be framed, so it is worth saying which one it is.
    const granted = await chrome.permissions.contains({ origins: ["https://*/*"] });
    if (!granted) {
      throw new Error(
        "site access is withheld; set this extension to run on all sites",
      );
    }
    await allowFramingInTab(self.id);
    // Read back rather than assume: the call resolving does not prove a rule
    // was installed, and a silently absent rule looks exactly like a site
    // refusing to be framed.
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    framing = rules.some((rule) => rule.condition.tabIds?.includes(self.id!));
    if (!framing) throw new Error("session rule was not installed");
    hideProgress();
  } catch (cause) {
    console.warn("preview framing unavailable", cause);
    setProgress(
      "Live previews unavailable",
      null,
      `Sites that refuse framing will not render. ${cause}`,
    );
  }

  // Two views, each with its own tabs: x.com posts as a list, everything else
  // as cards. The posts come up first, and deciding the last of them moves on
  // to the cards. The tally is shared, so switching is never a fresh start.
  const counts = emptyCounts();
  const isPost = (item: QueueItem) => tweetIdFromUrl(item.url) !== null;
  /** Posts decided in the list, however they were decided, so none returns. */
  const decidedPosts = new Set<QueueItem>();
  const remainingPosts = () =>
    items.filter((item) => isPost(item) && !decidedPosts.has(item));
  /** The queue removes what it deals with itself, so only undecided cards are kept. */
  let remainingCards = items.filter((item) => !isPost(item));
  let cards: QueueHandle | undefined;

  const shared = {
    counts,
    async apply(item: QueueItem, disposition: Disposition) {
      const failure = await applyDisposition(item, disposition);
      if (failure) return failure;
      if (isPost(item)) decidedPosts.add(item);
      else if (closesTab(disposition)) {
        remainingCards = remainingCards.filter((other) => other !== item);
      }
      return null;
    },
    async undo(item: QueueItem, disposition: Disposition) {
      decidedPosts.delete(item);
      // Whatever was sent has been sent; what can be undone is the closing.
      if (!closesTab(disposition)) return;
      const session = await chrome.sessions.restore();
      // The restored tab is a new tab with a new id, and the old one would
      // make the next decision about it act on nothing.
      if (session.tab?.id !== undefined) {
        item.id = session.tab.id;
        item.windowId = session.tab.windowId;
      }
      if (!isPost(item) && !remainingCards.includes(item)) {
        // Back where it was in the order, not at the end.
        const kept = new Set(remainingCards).add(item);
        remainingCards = items.filter((other) => kept.has(other));
      }
    },
    finished() {
      rememberPlace(null);
      rememberView(false);
      // Nothing here is worth an unhandled rejection: the rule dies with the
      // browser anyway, and it was never installed if framing was unavailable.
      void stopAllowingFraming().catch(() => {});
      finish(
        "Done for now",
        `${counts.save} saved · ${counts.task} tasks · ${counts.close} closed · ` +
          `${counts.skip} skipped · ${counts.visit} opened. ` +
          "Rescan to pick up whatever the pile is now.",
      );
    },
  };

  function showCards() {
    const left = remainingCards;
    if (left.length === 0) {
      shared.finished();
      return;
    }
    const posts = remainingPosts().length;
    rememberView(posts > 0);
    cards = openQueue(left, {
      ...shared,
      readable: (item) => fetchReadableText(item.url),
      framing,
      startAt: resumeIndex(left),
      showing: (item) => rememberPlace(item),
      // Where nothing framable exists, the page's own picture.
      preview: (url, stripsHeaders) =>
        previewFor(url, stripsHeaders) ?? (stripsHeaders ? null : harvestedStill(url)),
      other: posts > 0 ? { label: `Posts (${posts})`, open: showPosts } : undefined,
    });
  }

  function showPosts() {
    cards = undefined;
    const posts = remainingPosts();
    if (posts.length === 0) {
      showCards();
      return;
    }
    rememberView(false);
    rememberPlace(null);
    openPostList(posts, {
      ...shared,
      other: { label: `Cards (${remainingCards.length})`, open: showCards },
    });
  }

  if (new URLSearchParams(location.search).get(VIEW_PARAM) === CARDS_VIEW) showCards();
  else showPosts();

  // A refused frame is indistinguishable from a slow one from inside the page,
  // so the card only knows to show something else if the browser says so.
  unwatch =
    tabId === undefined
      ? undefined
      : watchBlockedFrames(tabId, (url) => cards?.previewBlocked(url));
}

/** Whether a disposition ends with the tab closed. */
function closesTab(disposition: Disposition): boolean {
  return disposition === "save" || disposition === "task" || disposition === "close";
}

function finish(label: string, note: string) {
  unwatch?.();
  unwatch = undefined;
  setProgress(label, 1, note);
}

/**
 * The page's own picture, from whatever was harvested for it.
 *
 * Used where a live view cannot be had. For most sites this is og:image; for
 * an x.com post it is the photo the syndication endpoint returned, which is
 * the only picture of a post that exists outside the site.
 */
function harvestedStill(url: string): Preview | null {
  const image = records.get(url)?.meta?.image;
  if (!image) return null;
  return { kind: "image", url: image, note: "Showing the page's own image." };
}

// ===== Wiring =====

el("rescan").addEventListener("click", () => {
  rememberPlace(null);
  void run();
});

void run();
