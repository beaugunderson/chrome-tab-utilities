// Semantic tab triage.
//
// Embeds every tab once, builds one dendrogram, then lets the granularity
// slider re-slice it. Slicing is a tree walk, so dragging never re-clusters.
// Nothing touches a real tab until an action button is pressed.

import {
  type CutCluster,
  type ClusterInput,
  type Merge,
  collectMembers,
  cutTreeInconsistent,
  defaultThreshold,
  distanceMatrix,
  dot,
  inconsistencies,
  linkage,
  maxInconsistencies,
  nearDuplicatePairs,
  sortedInconsistencies,
  subCut,
  subCutThreshold,
} from "../../lib/cluster";
import { embedAll, loadEmbedder } from "../../lib/embed";
import {
  type PageMeta,
  featureFingerprint,
  featureText,
  hasMetaContent,
  isRealTitle,
} from "../../lib/features";
import { type LabelSource, labelClusters } from "../../lib/label";
import {
  type TabRecord,
  dequantize,
  loadRecords,
  pruneStore,
  quantize,
  saveRecords,
} from "../../lib/store";
import { removeTabs } from "../../lib/tabs";
import { domainKey, hostOf } from "../../lib/url";

const NEAR_DUPLICATE_SIMILARITY = 0.95;
const TAG_SUGGEST_SIMILARITY = 0.8;
// Quantile of a subtree's own merge heights used when drilling into it.
const SUB_CUT_QUANTILE = 0.6;
// Below this size a cluster shows its tabs directly rather than sub-clusters.
const MIN_SUBCLUSTER_PARENT = 6;
const KEEP_NEWEST_COUNT = 3;
const MAX_GROUP_TITLE = 30;
// Page-metadata requests in flight while backfilling.
const META_CONCURRENCY = 16;
// Discarded tabs are reloaded to read them, so this caps how many real page
// loads run at once. Each is discarded again as soon as its DOM is parsed, so
// residency is short and peak memory stays near this many partly-loaded pages.
const HARVEST_CONCURRENCY = 8;
// Metadata lands within tens of milliseconds of the HTML arriving, so this
// only has to cover a slow server, not a slow page. Measured: a page with one
// slow asset never reported `status: "complete"` within 15s while its metadata
// was ready at 34ms — waiting on the load event is what made this crawl.
const HARVEST_LOAD_TIMEOUT_MS = 20000;
// A page that yielded nothing is not asked again for this long. It might have
// been down or behind a login rather than genuinely empty.
interface HarvestOutcome {
  read: number;
  titleOnly: number;
  empty: number;
  timedOut: number;
}

const HARVEST_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const GROUP_COLORS: Array<`${chrome.tabGroups.Color}`> = [
  "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey",
];

const DEFAULT_FAVICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
      '<rect width="16" height="16" rx="3" fill="#c7c7c7"/></svg>',
  );

interface TriageTab {
  id: number;
  windowId: number;
  title: string;
  url: string;
  host: string | null;
  domain: string | null;
  favIconUrl?: string;
  discarded: boolean;
  groupId: number | null;
  idleMs: number;
  tags: string[];
  /** Harvested heading with site boilerplate removed; used for labels. */
  heading?: string;
  vec: Float32Array;
}

interface State {
  tabs: TriageTab[];
  merges: Merge[];
  /** Largest inconsistency in each node's subtree; what the slider cuts on. */
  maxScores: Float64Array;
  /** Distinct subtree inconsistencies, ascending, for the slider to index. */
  scale: number[];
  /** How many tabs contributed harvested page metadata, for the stats line. */
  withMeta: number;
  /**
   * Node ids the user has folded shut. Tracking collapses rather than
   * expansions means everything is open by default, including clusters that
   * only come into existence when the slider moves.
   */
  collapsed: Set<number>;
  selected: Set<number>;
  /**
   * Leaf indices whose tab is gone. Closing a tab drops it from the view
   * instead of re-clustering: rebuilding the dendrogram over the remaining
   * tabs would renumber every node, rescale the slider and reshuffle the
   * groups underneath whoever just closed something.
   */
  removed: Set<number>;
  dupeGroups: number[][];
  /**
   * Tabs known only by their address: never loaded, so no title, and never
   * read, so no content. Kept out of the tree and listed separately.
   */
  unidentified: TriageTab[];
  records: Map<string, TabRecord>;
}

let state: State | null = null;

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// ===== Loading =====

function setProgress(label: string, fraction: number | null, note = "") {
  el("progress").hidden = false;
  el("progress-label").textContent = label;
  el("progress-note").textContent = note;
  const bar = el<HTMLElement>("progress-bar");
  bar.classList.toggle("indeterminate", fraction === null);
  bar.style.width = fraction === null ? "100%" : `${Math.round(fraction * 100)}%`;
}

function hideProgress() {
  el("progress").hidden = true;
}

/** Follow the opener chain to its origin, so a whole branch shares one key. */
function openerRoot(url: string, records: Map<string, TabRecord>): string | null {
  const seen = new Set<string>([url]);
  let current = url;
  for (let hop = 0; hop < 12; hop++) {
    const next = records.get(current)?.opener;
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === url ? null : current;
}

/** Empty tabs carry no content to cluster and nothing to decide about. */
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
      t.url !== selfUrl &&
      !isBlankTab(t.url) &&
      // Pinned tabs are deliberate keeps, so they stay out of a closure tool.
      !t.pinned,
  );
}

/**
 * Ask each loaded tab's content script for its page metadata directly.
 *
 * The content script only reports on page load, so every tab that was already
 * open before the extension was installed has none cached, and on a large
 * long-lived tab set that is nearly all of them — leaving titles and URL words
 * as the only clustering signal. Discarded tabs have no content script and are
 * skipped; they keep whatever was cached from when they were last loaded.
 */
async function backfillMeta(
  tabs: chrome.tabs.Tab[],
  records: Map<string, TabRecord>,
): Promise<number> {
  const missing = tabs.filter(
    (t) => !t.discarded && t.status === "complete" && !records.get(t.url!)?.meta,
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
      if (response?.meta) {
        const record = { ...(records.get(tab.url!) ?? {}), meta: response.meta };
        records.set(tab.url!, record);
        updates.set(tab.url!, record);
      }
    } catch {
      // No content script on this page (chrome://, the web store, a tab that
      // has not finished loading). Nothing to recover.
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
 * Reload discarded tabs one small batch at a time to read their metadata, then
 * discard them again.
 *
 * Explicit rather than automatic: this is one real page load per tab, so on a
 * large tab set it is hundreds of HTTP requests. Only reachable from a button
 * that states the count. Concurrency is low so at most a handful of tabs are
 * resident at once, and abandoning it midway is safe — the discard sweep puts
 * anything left loaded back to sleep within the hour.
 */
async function harvestDiscarded(
  tabs: chrome.tabs.Tab[],
  records: Map<string, TabRecord>,
): Promise<HarvestOutcome> {
  return harvestTabs(
    harvestTargets(tabs, records).map((t) => ({ id: t.id!, url: t.url! })),
    records,
  );
}

/** Load, read and re-discard an explicit list of tabs. */
async function harvestTabs(
  targets: Array<{ id: number; url: string }>,
  records: Map<string, TabRecord>,
): Promise<HarvestOutcome> {
  if (targets.length === 0)
    return { read: 0, titleOnly: 0, empty: 0, timedOut: 0 };

  const updates = new Map<string, TabRecord>();
  const now = Date.now();
  let done = 0;
  let withText = 0;
  let titleOnly = 0;
  let empty = 0;
  let timedOut = 0;

  const started = performance.now();
  // Say something before the first tab finishes, or the click looks inert.
  setProgress(`Reading unloaded tabs… 0/${targets.length}`, 0, "Loading each one, reading it, then discarding it again.");
  el("progress").scrollIntoView({ block: "center" });

  await mapWithConcurrency(targets, HARVEST_CONCURRENCY, async (tab) => {
    const caught = await reloadAndCapture(tab.id, tab.url);
    // The attempt is recorded whether or not anything came back. Plenty of
    // pages carry no description, og tags or h1 at all, and without this they
    // would be reloaded again on every future pass forever.
    const url = caught?.url ?? tab.url;
    const gotMeta = hasMetaContent(caught?.meta);
    const gotTitle = isRealTitle(caught?.title, url);
    const outcome = gotMeta
      ? ("text" as const)
      : gotTitle
        ? ("title" as const)
        : caught
          ? ("empty" as const)
          : ("timeout" as const);
    const record: TabRecord = {
      ...(records.get(url) ?? {}),
      metaTried: now,
      metaOutcome: outcome,
      ...(gotMeta ? { meta: caught!.meta } : {}),
      ...(gotTitle ? { title: caught!.title } : {}),
    };
    records.set(url, record);
    updates.set(url, record);
    // A title alone is a real result: on a JS app it is often the only thing
    // the page ever exposes, and it is enough to cluster on.
    if (outcome === "text") withText++;
    else if (outcome === "title") titleOnly++;
    else if (outcome === "empty") empty++;
    else timedOut++;
    done++;
    const rate = done / ((performance.now() - started) / 1000);
    const left = Math.round((targets.length - done) / Math.max(rate, 0.01));
    setProgress(
      `Reading unloaded tabs… ${done}/${targets.length}`,
      done / targets.length,
      `${rate.toFixed(1)}/s · about ${formatDuration(left)} left`,
    );
  });

  await saveRecords(updates);
  return { read: withText + titleOnly, titleOnly, empty, timedOut };
}

/**
 * Discarded tabs worth loading: no metadata yet, and not already tried
 * recently. Without the second half, pages that simply have nothing to read
 * would be offered and reloaded on every pass.
 */
function harvestTargets(
  tabs: chrome.tabs.Tab[],
  records: Map<string, TabRecord>,
): chrome.tabs.Tab[] {
  const staleBefore = Date.now() - HARVEST_RETRY_AFTER_MS;
  return tabs.filter((t) => {
    // Unloaded covers more than discarded: a tab restored from a session but
    // never opened has no content script either, and is not marked discarded.
    const unloaded = t.discarded || t.status === "unloaded";
    if (!unloaded || !t.url?.startsWith("http")) return false;
    const record = records.get(t.url);
    if (record?.meta) return false;
    // Retried eventually, since a page can be empty because it failed to load.
    return (record?.metaTried ?? 0) < staleBefore;
  });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * Tabs waiting on their content script to report in, keyed by tab id. The
 * content script pushes its metadata at DOMContentLoaded, and every extension
 * page receives that message, so this page can catch it directly.
 */
const awaitingMeta = new Map<
  number,
  (result: { url: string; title?: string; meta: PageMeta }) => void
>();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "page-meta" || sender.tab?.id === undefined) return;
  awaitingMeta.get(sender.tab.id)?.({
    url: msg.url,
    title: msg.title,
    meta: msg.meta,
  });
});

/**
 * Reload a tab, grab its metadata the moment the DOM is parsed, and put it
 * straight back to sleep.
 *
 * Waiting for `status: "complete"` would mean waiting for every image, font
 * and tracker on the page, which is most of the wall clock and none of the
 * value: the meta tags, h1 and JSON-LD are all present at DOMContentLoaded.
 * Discarding at that point also cancels whatever is still in flight, so each
 * tab is resident for a fraction of a full load.
 *
 * Chrome can hand a reloaded tab a brand new id, so replacements are tracked.
 */
function reloadAndCapture(
  tabId: number,
  url: string,
): Promise<{ url: string; title?: string; meta: PageMeta } | null> {
  return new Promise((resolve) => {
    let current = tabId;
    let settled = false;

    const finish = (result: { url: string; title?: string; meta: PageMeta } | null) => {
      if (settled) return;
      settled = true;
      awaitingMeta.delete(current);
      chrome.tabs.onReplaced.removeListener(onReplaced);
      clearTimeout(timer);
      // Back to sleep immediately; this is also what aborts the rest of the
      // page load.
      chrome.tabs.discard(current).catch(() => {
        // Became active while we held it; the sweep will get it later.
      });
      resolve(result);
    };

    const capture = (result: { url: string; title?: string; meta: PageMeta }) =>
      finish(result);

    // Deliberately no listener for `status: "complete"`. A JS app often
    // reports complete before it has rendered anything, and discarding at that
    // point captured nothing — not even the title, which the app sets later.
    // The content script decides when it has looked long enough and says so;
    // the timeout below covers pages whose script never runs at all.
    const onReplaced = (added: number, removed: number) => {
      if (removed !== current) return;
      awaitingMeta.delete(current);
      current = added;
      awaitingMeta.set(current, capture);
    };

    const timer = setTimeout(() => finish(null), HARVEST_LOAD_TIMEOUT_MS);

    awaitingMeta.set(current, capture);
    chrome.tabs.onReplaced.addListener(onReplaced);
    // Navigate to the URL rather than reload(). Reloading a page that arrived
    // via POST re-submits the form, which puts up Chrome's "Confirm Form
    // Resubmission" interstitial and stalls the tab until the timeout. A fresh
    // navigation is a plain GET, so the prompt never appears — and re-sending
    // someone's form just to read a meta tag would be the wrong thing to do
    // regardless.
    chrome.tabs.update(current, { url }).catch(() => finish(null));
  });
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

async function run() {
  // Hold the granularity across the rebuild, since the slider scale changes.
  const previousThreshold = state ? currentThreshold() : null;
  setProgress("Reading tabs…", null);
  const raw = await collectTabs();
  if (raw.length < 2) {
    hideProgress();
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Not enough unpinned tabs to cluster.";
    el("clusters").replaceChildren(empty);
    return;
  }

  const urls = raw.map((t) => t.url!);
  const records = await loadRecords(urls);
  await backfillMeta(raw, records);

  // Decide what needs embedding: anything with no cached vector, or whose
  // title, harvested metadata or tags have changed since it was embedded.
  const boilerplate = boilerplateHeadings(raw, records);
  // Chrome reports the URL as the title for a tab it never loaded; the page
  // itself told us better the last time it was read.
  const bestTitle = (
    live: string | undefined,
    record: TabRecord | undefined,
    url: string,
  ) => (isRealTitle(live, url) ? live! : (record?.title ?? live ?? url));

  const sources = raw.map((t) => {
    const record = records.get(t.url!);
    return {
      title: bestTitle(t.title, record, t.url!),
      url: t.url,
      meta: record?.meta && {
        ...record.meta,
        heading: usableHeading(t.url!, record, boilerplate),
      },
      tags: record?.tags,
    };
  });
  const fingerprints = sources.map(featureFingerprint);
  const stale: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const record = records.get(urls[i]);
    if (!record?.v || record.fp !== fingerprints[i]) stale.push(i);
  }

  if (stale.length > 0) {
    setProgress("Loading model…", null, "First run downloads ~25MB, then it is cached.");
    await loadEmbedder((p) => {
      if (p.status === "progress" && typeof p.progress === "number") {
        setProgress("Downloading model…", p.progress / 100, p.file ?? "");
      }
    });

    const started = performance.now();
    const vectors = await embedAll(
      stale.map((i) => featureText(sources[i])),
      (done, total) =>
        setProgress(`Embedding tabs… ${done}/${total}`, done / total),
    );
    const elapsed = Math.round(performance.now() - started);

    const updates = new Map<string, TabRecord>();
    for (let k = 0; k < stale.length; k++) {
      const i = stale[k];
      const existing = records.get(urls[i]) ?? {};
      const updated: TabRecord = {
        ...existing,
        v: quantize(vectors[k]),
        fp: fingerprints[i],
      };
      records.set(urls[i], updated);
      updates.set(urls[i], updated);
    }
    // One batched write for the whole run.
    setProgress("Caching…", null, `${stale.length} embedded in ${elapsed}ms`);
    await saveRecords(updates);
    void pruneStore();
  }

  setProgress("Clustering…", null);
  const now = Date.now();
  const tabs: TriageTab[] = [];
  const unidentified: TriageTab[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const record = records.get(urls[i]);
    if (!record?.v) continue;
    // lastAccessed resets on browser restart, so fall back to the snapshot the
    // background keeps per URL, whichever is more recent.
    const lastSeen = Math.max(t.lastAccessed ?? 0, record.seen ?? 0);
    const bucket = isUnidentified(t.title, urls[i], record) ? unidentified : tabs;
    bucket.push({
      id: t.id!,
      windowId: t.windowId!,
      title: bestTitle(t.title, record, urls[i]),
      url: urls[i],
      host: hostOf(urls[i]),
      domain: domainKey(urls[i]),
      favIconUrl: t.favIconUrl,
      discarded: t.discarded ?? false,
      groupId: t.groupId !== undefined && t.groupId >= 0 ? t.groupId : null,
      idleMs: lastSeen > 0 ? now - lastSeen : Number.POSITIVE_INFINITY,
      tags: record.tags ?? [],
      heading: usableHeading(urls[i], record, boilerplate),
      vec: dequantize(record.v),
    });
  }

  const inputs: ClusterInput[] = tabs.map((t) => ({
    vec: t.vec,
    domain: t.domain,
    openerRoot: openerRoot(t.url, records),
    groupId: t.groupId,
  }));

  const condensed = distanceMatrix(inputs);
  const merges = linkage(condensed, inputs.length);
  const maxScores = maxInconsistencies(
    merges,
    inputs.length,
    inconsistencies(merges, inputs.length),
  );

  state = {
    tabs,
    merges,
    maxScores,
    scale: sortedInconsistencies(maxScores),
    withMeta: tabs.filter((t) => records.get(t.url)?.meta).length,
    collapsed: new Set(),
    removed: new Set(),
    unidentified,
    selected: new Set(),
    dupeGroups: groupDuplicates(
      nearDuplicatePairs(
        inputs,
        NEAR_DUPLICATE_SIMILARITY,
        // Only tabs whose page has actually been read can be called
        // duplicates. A title and a URL shape are not enough: every tweet by
        // one author looks the same through that lens.
        tabs.map((t) => hasReadableContent(records.get(t.url))),
      ),
    ),
    records,
  };

  hideProgress();
  el("granularity").hidden = false;
  parkSliderAt(
    previousThreshold ??
      defaultThreshold(merges, tabs.length, maxScores, state.scale),
  );
  render();
  offerBacklog(raw, records);
}

/**
 * Whether a page's own words were ever read, as opposed to only its title and
 * URL. A description or a heading counts; og:type and a site name do not,
 * since every page on a site shares those.
 */
function hasReadableContent(record: TabRecord | undefined): boolean {
  const meta = record?.meta;
  return Boolean(meta?.description?.trim() || meta?.heading?.trim());
}

/**
 * A tab Chrome has never loaded shows its URL where the title would be, and if
 * nothing has read the page either then all that is known about it is its
 * address.
 *
 * These cannot be clustered honestly. Every tweet by one author, every issue in
 * one repo, reduces to the same few words — the host and a path shape — so they
 * embed identically, pile into one indistinguishable lump, and act as bridges
 * that drag unrelated clusters together. They get their own section instead.
 */
function isUnidentified(
  title: string | undefined,
  url: string,
  record: TabRecord | undefined,
): boolean {
  if (hasReadableContent(record)) return false;
  // Either the live tab title or the one the page reported when last read.
  return !isRealTitle(title, url) && !isRealTitle(record?.title, url);
}

/** A heading this many tabs of one site share is the site's furniture. */
const BOILERPLATE_HEADING_COUNT = 3;

/**
 * Headings that are part of a site rather than a page, found by counting.
 *
 * No per-site rules and no re-harvest needed: if three pages on one host claim
 * the same heading it describes the host, not any of them. Catches the hidden
 * "Command palette" already cached for 73 GitHub tabs, and site banners like a
 * blog's own name repeated on every post.
 */
function boilerplateHeadings(
  tabs: chrome.tabs.Tab[],
  records: Map<string, TabRecord>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const heading = records.get(tab.url!)?.meta?.heading?.trim();
    if (!heading) continue;
    const key = `${hostOf(tab.url!) ?? ""}|${heading.toLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [key, count] of counts) {
    if (count >= BOILERPLATE_HEADING_COUNT) out.add(key);
  }
  return out;
}

function usableHeading(
  url: string,
  record: TabRecord | undefined,
  boilerplate: Set<string>,
): string | undefined {
  const heading = record?.meta?.heading?.trim();
  if (!heading) return undefined;
  const host = hostOf(url) ?? "";
  if (boilerplate.has(`${host}|${heading.toLowerCase()}`)) return undefined;
  // A heading that is just the site's name says nothing about the page.
  const compact = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact(heading) === compact(host)) return undefined;
  const siteName = record?.meta?.siteName;
  if (siteName && compact(heading) === compact(siteName)) return undefined;
  return heading;
}

/** Merge overlapping duplicate pairs into groups via union-find. */
function groupDuplicates(pairs: Array<[number, number]>): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    let root = parent.get(x)!;
    while (root !== parent.get(root)) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const [a, b] of pairs) parent.set(find(a), find(b));

  const groups = new Map<number, number[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(key);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length);
}

// ===== Scoring =====

const DAY_MS = 24 * 60 * 60 * 1000;

function idleDays(tab: TriageTab): number {
  return tab.idleMs === Number.POSITIVE_INFINITY ? 999 : tab.idleMs / DAY_MS;
}

function medianIdleDays(tabs: TriageTab[]): number {
  if (tabs.length === 0) return 0;
  const sorted = tabs.map(idleDays).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * How much closing this cluster would help: big, stale and internally
 * redundant all push it up the page.
 */
function closureScore(tabs: TriageTab[], dupeCount: number): number {
  const dupeFraction = tabs.length > 0 ? dupeCount / tabs.length : 0;
  return tabs.length * (medianIdleDays(tabs) + 1) * (1 + dupeFraction);
}

function formatIdle(days: number): string {
  if (days >= 900) return "never";
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

// ===== Rendering =====

let backlogDismissed = false;
/** Outcome of the last backlog pass, shown in the stats line. */
let lastHarvest = "";

/**
 * Offer to read the discarded tabs, stating the cost. Auto-discard means most
 * of a long-lived tab set is unloaded, and an unloaded tab has no content
 * script to ask, so without this the clustering runs on titles alone.
 */
function offerBacklog(tabs: chrome.tabs.Tab[], records: Map<string, TabRecord>) {
  const banner = el("backlog");
  if (backlogDismissed) {
    banner.hidden = true;
    return;
  }
  const targets = harvestTargets(tabs, records);
  if (targets.length === 0) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  el("backlog-text").textContent =
    `${targets.length} unloaded tabs are being clustered on their titles alone. ` +
    `Reading their page text means loading each one once (${targets.length} page loads), ` +
    `then discarding it again.`;

  el("backlog-run").onclick = async () => {
    banner.hidden = true;
    const { read, titleOnly, empty } = await harvestDiscarded(tabs, records);
    lastHarvest =
      `Read ${read} tabs` +
      (titleOnly > 0 ? ` (${titleOnly} title only)` : "") +
      (empty > 0 ? `; ${empty} had nothing to read` : "") +
      ".";
    setProgress(`${lastHarvest} Re-clustering…`, null);
    await run();
  };
  el("backlog-dismiss").onclick = () => {
    backlogDismissed = true;
    banner.hidden = true;
  };
}

/**
 * Park the slider at the quantile closest to a given inconsistency.
 *
 * Restoring the *value* rather than the slider position is what keeps
 * granularity stable across a rescan: the quantile scale is rebuilt from
 * whatever tabs exist now, so position 400 means something different every
 * time, while inconsistency 1.4 means the same thing at any tab count.
 */
function parkSliderAt(target: number) {
  if (!state || state.scale.length === 0) return;
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < state.scale.length; i++) {
    const gap = Math.abs(state.scale[i] - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  const position = Math.round((best / Math.max(1, state.scale.length - 1)) * 1000);
  el<HTMLInputElement>("cut").value = String(position);
}

/**
 * Slider position to an inconsistency threshold, by quantile of the values
 * actually present so every position changes something.
 */
function currentThreshold(): number {
  if (!state || state.scale.length === 0) return 0;
  const position = Number(el<HTMLInputElement>("cut").value) / 1000;
  const index = Math.min(
    state.scale.length - 1,
    Math.max(0, Math.round(position * (state.scale.length - 1))),
  );
  return state.scale[index];
}

/** Members of a cluster that are still open. */
function tabsOf(leaves: number[]): TriageTab[] {
  return leaves
    .filter((i) => !state!.removed.has(i))
    .map((i) => state!.tabs[i]);
}

function labelSources(leaves: number[]): LabelSource[] {
  return leaves.filter((i) => !state!.removed.has(i)).map((i) => {
    const tab = state!.tabs[i];
    const record = state!.records.get(tab.url);
    return {
      text: [tab.title, tab.heading, tab.tags.join(" ")].filter(Boolean).join(" "),
      site: tab.host,
    };
  });
}

/** Values shared by every cluster in one render pass. */
interface RenderContext {
  members: number[][];
  dupeIndices: Set<number>;
}

/** Order clusters by how much closing them would help, largest payoff first. */
function rank(clusters: CutCluster[], context: RenderContext) {
  const labels = labelClusters(clusters.map((c) => labelSources(c.leaves)));
  return clusters
    .map((cluster, i) => ({
      cluster,
      label: labels[i],
      tabs: tabsOf(cluster.leaves),
      dupes: cluster.leaves.filter(
        (leaf) => context.dupeIndices.has(leaf) && !state!.removed.has(leaf),
      ).length,
    }))
    // A cluster whose tabs have all been closed leaves the page rather than
    // lingering as an empty header.
    .filter((entry) => entry.tabs.length > 0)
    .sort((a, b) => closureScore(b.tabs, b.dupes) - closureScore(a.tabs, a.dupes));
}

/**
 * Every checkbox currently on the page, so a click can update the others
 * without a full re-render. Rebuilt by each render.
 *
 * Cluster boxes are tri-state: checked when all their tabs are selected,
 * indeterminate when only some are. That is what makes selecting every tab in
 * a group show the group itself as selected, at every level of nesting, since
 * a parent's tab list contains all of its descendants'.
 */
const rowChecks: Array<{ box: HTMLInputElement; tabId: number }> = [];
const groupChecks: Array<{ box: HTMLInputElement; tabIds: number[] }> = [];

function syncChecks() {
  if (!state) return;
  for (const { box, tabId } of rowChecks) {
    box.checked = state.selected.has(tabId);
  }
  for (const { box, tabIds } of groupChecks) {
    const selected = tabIds.filter((id) => state!.selected.has(id)).length;
    box.checked = selected > 0 && selected === tabIds.length;
    box.indeterminate = selected > 0 && selected < tabIds.length;
  }
  renderSelection();
}

let renderQueued = false;

/**
 * Coalesce renders to one per frame. Dragging the slider fires `input` on every
 * pixel, and with all clusters expanded a pass rebuilds every visible row.
 */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  if (!state) return;
  // The boxes about to be discarded must not be synced against later.
  rowChecks.length = 0;
  groupChecks.length = 0;
  const threshold = currentThreshold();
  const context: RenderContext = {
    members: collectMembers(state.merges, state.tabs.length),
    dupeIndices: new Set(state.dupeGroups.flat()),
  };
  const clusters = cutTreeInconsistent(
    state.merges,
    state.tabs.length,
    threshold,
    state.maxScores,
    context.members,
  );
  const ranked = rank(clusters, context);

  // Counts follow what is still open, so they tick down as tabs are closed.
  const live = state.tabs.length - state.removed.size;
  const liveDupes = [...context.dupeIndices].filter(
    (i) => !state!.removed.has(i),
  ).length;
  const liveWithMeta = state.tabs.filter(
    (t, i) => !state!.removed.has(i) && state!.records.get(t.url)?.meta,
  ).length;
  const metaShare = live > 0 ? Math.round((liveWithMeta / live) * 100) : 0;
  const closed = state.removed.size;

  el("cut-readout").textContent = `${ranked.length} clusters`;
  el("stats").textContent =
    `${live} tabs · ${ranked.length} clusters · ${liveDupes} near-duplicates · ` +
    `${metaShare}% with page metadata` +
    (closed > 0 ? ` · ${closed} closed this session` : "");
  if (lastHarvest) el("stats").textContent += ` · ${lastHarvest}`;

  const host = el("clusters");
  if (ranked.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      closed > 0
        ? `All ${closed} tabs closed. Rescan to start over.`
        : "Nothing to triage.";
    host.replaceChildren(empty);
    renderUnidentified();
    renderDuplicates();
    syncChecks();
    return;
  }
  host.replaceChildren(
    ...ranked.map((entry) =>
      renderCluster(entry.cluster, entry.label, entry.tabs, entry.dupes, 0, context),
    ),
  );

  updateFoldAllLabel();
  renderUnidentified();
  renderDuplicates();
  syncChecks();
}

function renderCluster(
  cluster: CutCluster,
  label: string,
  tabs: TriageTab[],
  dupes: number,
  depth: number,
  context: RenderContext,
): HTMLElement {
  // A cluster of one is just a tab. Rendering it as a header would leave it
  // without the close button, tag control and click-to-activate every other
  // tab has.
  if (tabs.length === 1) {
    const row = renderTab(tabs[0]);
    row.style.setProperty("--depth", String(depth));
    return row;
  }

  const wrapper = document.createElement("section");
  wrapper.className = "cluster";
  wrapper.style.setProperty("--depth", String(depth));

  const isExpanded = !state!.collapsed.has(cluster.node);

  const header = document.createElement("div");
  header.className = "cluster-header";

  const chevron = document.createElement("button");
  chevron.className = "chevron";
  chevron.textContent = isExpanded ? "▼" : "▶";
  chevron.setAttribute(
    "aria-label",
    isExpanded ? "Collapse cluster" : "Expand cluster",
  );
  chevron.addEventListener("click", () => {
    if (isExpanded) state!.collapsed.add(cluster.node);
    else state!.collapsed.delete(cluster.node);
    render();
  });

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "cluster-check";
  check.title = "Select every tab in this cluster";
  const clusterTabIds = tabs.map((t) => t.id);
  groupChecks.push({ box: check, tabIds: clusterTabIds });
  check.addEventListener("change", () => {
    for (const id of clusterTabIds) {
      if (check.checked) state!.selected.add(id);
      else state!.selected.delete(id);
    }
    // Updating the other boxes in place rather than re-rendering keeps the
    // page from rebuilding hundreds of rows on every click.
    syncChecks();
  });

  const name = document.createElement("span");
  name.className = "cluster-name";
  name.textContent = label;

  const meta = document.createElement("span");
  meta.className = "cluster-meta";
  const parts = [`${tabs.length} tab${tabs.length === 1 ? "" : "s"}`];
  parts.push(`${formatIdle(medianIdleDays(tabs))} idle`);
  if (dupes > 0) parts.push(`${dupes} dupe`);
  meta.textContent = parts.join(" · ");

  header.append(chevron, check, name, meta, clusterActions(tabs, label));
  wrapper.append(header);

  if (isExpanded) {
    const body = document.createElement("div");
    body.className = "cluster-body";

    const subs =
      tabs.length >= MIN_SUBCLUSTER_PARENT
        ? subCut(
            state!.merges,
            state!.tabs.length,
            cluster.node,
            subCutThreshold(
              state!.merges,
              state!.tabs.length,
              cluster.node,
              SUB_CUT_QUANTILE,
            ),
            context.members,
          )
        : null;

    if (subs && subs.length > 1) {
      for (const entry of rank(subs, context)) {
        body.append(
          renderCluster(
            entry.cluster,
            entry.label,
            entry.tabs,
            entry.dupes,
            depth + 1,
            context,
          ),
        );
      }
    } else {
      for (const tab of tabs) body.append(renderTab(tab));
    }
    wrapper.append(body);
  }

  return wrapper;
}

function clusterActions(tabs: TriageTab[], label: string): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "cluster-actions";

  const button = (text: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = "ghost small";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  };

  actions.append(
    button("Close all", `Close all ${tabs.length} tabs in this cluster`, () =>
      void closeAndRefresh(tabs.map((t) => t.id)),
    ),
  );

  if (tabs.length > KEEP_NEWEST_COUNT) {
    actions.append(
      button(
        `Keep ${KEEP_NEWEST_COUNT}`,
        `Close all but the ${KEEP_NEWEST_COUNT} most recently used`,
        () => {
          const doomed = [...tabs]
            .sort((a, b) => a.idleMs - b.idleMs)
            .slice(KEEP_NEWEST_COUNT)
            .map((t) => t.id);
          void closeAndRefresh(doomed);
        },
      ),
    );
  }

  actions.append(
    button("Group", "Apply as a Chrome tab group, per window", () =>
      void applyAsGroup(tabs, label),
    ),
    button("New window", "Move these tabs into their own window", () =>
      void moveToNewWindow(tabs),
    ),
    button("Tag all", "Apply a tag to every tab in this cluster", () =>
      void tagAll(tabs),
    ),
  );

  return actions;
}

function renderTab(tab: TriageTab): HTMLElement {
  const row = document.createElement("div");
  row.className = "tab-row";
  if (tab.discarded) row.classList.add("discarded");

  const check = document.createElement("input");
  check.type = "checkbox";
  rowChecks.push({ box: check, tabId: tab.id });
  check.addEventListener("change", () => {
    if (check.checked) state!.selected.add(tab.id);
    else state!.selected.delete(tab.id);
    // Ticking the last unticked sibling has to tick the cluster above it, and
    // its parent in turn.
    syncChecks();
  });

  const icon = document.createElement("img");
  icon.className = "favicon";
  icon.src = tab.favIconUrl || DEFAULT_FAVICON;
  icon.addEventListener("error", () => {
    icon.src = DEFAULT_FAVICON;
  });

  const title = document.createElement("button");
  title.className = "tab-title";
  title.textContent = tab.title;
  title.title = tab.url;
  title.addEventListener("click", () => {
    void chrome.tabs.update(tab.id, { active: true });
    void chrome.windows.update(tab.windowId, { focused: true });
  });

  const host = document.createElement("span");
  host.className = "tab-host";
  host.textContent = tab.host ?? "";

  const idle = document.createElement("span");
  idle.className = "tab-idle";
  idle.textContent = formatIdle(idleDays(tab));

  const close = document.createElement("button");
  close.className = "tab-close";
  close.textContent = "×";
  close.title = "Close this tab";
  close.addEventListener("click", () => void closeAndRefresh([tab.id]));

  row.append(check, icon, title, renderTags(tab), host, idle, close);
  return row;
}

// ===== Tags =====

/** Mean of every tagged tab's vector, per tag, renormalized to unit length. */
function tagCentroids(): Map<string, Float32Array> {
  const sums = new Map<string, { vec: Float64Array; count: number }>();
  for (const tab of state!.tabs) {
    for (const tag of tab.tags) {
      let entry = sums.get(tag);
      if (!entry) {
        entry = { vec: new Float64Array(tab.vec.length), count: 0 };
        sums.set(tag, entry);
      }
      for (let i = 0; i < tab.vec.length; i++) entry.vec[i] += tab.vec[i];
      entry.count++;
    }
  }

  const out = new Map<string, Float32Array>();
  for (const [tag, { vec }] of sums) {
    const centroid = new Float32Array(vec.length);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    for (let i = 0; i < vec.length; i++) centroid[i] = vec[i] / norm;
    out.set(tag, centroid);
  }
  return out;
}

let centroidCache: Map<string, Float32Array> | null = null;

function suggestionsFor(tab: TriageTab): string[] {
  centroidCache ??= tagCentroids();
  const out: string[] = [];
  for (const [tag, centroid] of centroidCache) {
    if (tab.tags.includes(tag)) continue;
    if (dot(tab.vec, centroid) >= TAG_SUGGEST_SIMILARITY) out.push(tag);
  }
  return out;
}

function renderTags(tab: TriageTab): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "tags";

  for (const tag of tab.tags) {
    const chip = document.createElement("button");
    chip.className = "tag";
    chip.textContent = tag;
    chip.title = "Remove this tag";
    chip.addEventListener("click", () => void applyTags(tab, tab.tags.filter((t) => t !== tag)));
    wrap.append(chip);
  }

  // Tags this tab sits close to but does not carry: one click to accept.
  for (const tag of suggestionsFor(tab)) {
    const chip = document.createElement("button");
    chip.className = "tag suggested";
    chip.textContent = tag;
    chip.title = "Suggested from similar tabs — click to apply";
    chip.addEventListener("click", () => void applyTags(tab, [...tab.tags, tag]));
    wrap.append(chip);
  }

  const add = document.createElement("button");
  add.className = "tag add";
  add.textContent = "+";
  add.title = "Add a tag";
  add.addEventListener("click", () => {
    const value = prompt("Tag for this tab:")?.trim();
    if (value) void applyTags(tab, [...tab.tags, value]);
  });
  wrap.append(add);

  return wrap;
}

async function applyTags(tab: TriageTab, tags: string[]) {
  const unique = [...new Set(tags)];
  tab.tags = unique;
  const record = { ...(state!.records.get(tab.url) ?? {}), tags: unique };
  state!.records.set(tab.url, record);
  await saveRecords(new Map([[tab.url, record]]));
  centroidCache = null;
  render();
}

async function tagAll(tabs: TriageTab[]) {
  const value = prompt(`Tag all ${tabs.length} tabs with:`)?.trim();
  if (!value) return;
  const updates = new Map<string, TabRecord>();
  for (const tab of tabs) {
    tab.tags = [...new Set([...tab.tags, value])];
    const record = { ...(state!.records.get(tab.url) ?? {}), tags: tab.tags };
    state!.records.set(tab.url, record);
    updates.set(tab.url, record);
  }
  await saveRecords(updates);
  centroidCache = null;
  render();
}

// ===== Actions =====

/**
 * Close tabs and drop them from the view, leaving the dendrogram untouched.
 *
 * Re-clustering here would rebuild the tree over a different tab set, which
 * renumbers every node, rebuilds the slider's quantile scale and reshuffles
 * the groups — so every close silently changed the granularity. Use Rescan for
 * a fresh clustering.
 */
async function closeAndRefresh(ids: number[]) {
  if (ids.length === 0 || !state) return;
  await removeTabs(ids);
  forgetTabs(ids);
  render();
}

/** Drop tabs from the view, whether we closed them or Chrome did. */
function forgetTabs(ids: number[]) {
  if (!state) return;
  const doomed = new Set(ids);
  for (let i = 0; i < state.tabs.length; i++) {
    if (doomed.has(state.tabs[i].id)) state.removed.add(i);
  }
  for (const id of ids) {
    state.selected.delete(id);
    unidentifiedClosed.add(id);
  }
}

async function applyAsGroup(tabs: TriageTab[], label: string) {
  // Chrome cannot group tabs across windows, so make one group per window.
  const byWindow = new Map<number, number[]>();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId)!.push(tab.id);
  }
  const color = GROUP_COLORS[Math.abs(hashString(label)) % GROUP_COLORS.length];
  for (const [windowId, tabIds] of byWindow) {
    if (tabIds.length === 0) continue;
    try {
      const groupId = await chrome.tabs.group({
        tabIds: tabIds as [number, ...number[]],
        createProperties: { windowId },
      });
      await chrome.tabGroups.update(groupId, {
        title: label.slice(0, MAX_GROUP_TITLE),
        color,
      });
    } catch {
      // A tab closed out from under us; the remaining windows still group.
    }
  }
  await run();
}

async function moveToNewWindow(tabs: TriageTab[]) {
  if (tabs.length === 0) return;
  const [first, ...rest] = tabs;
  const created = await chrome.windows.create({ tabId: first.id });
  if (created?.id === undefined || rest.length === 0) return;
  await chrome.tabs.move(
    rest.map((t) => t.id),
    { windowId: created.id, index: -1 },
  );
  await run();
}

function hashString(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
}

// ===== Duplicates and selection =====

/**
 * Tabs known only by their address, grouped by host. Nothing here can be
 * clustered by meaning, so the useful unit is the site.
 */
function renderUnidentified() {
  const host = el("unknown");
  const live = (state?.unidentified ?? []).filter(
    (t) => !unidentifiedClosed.has(t.id),
  );
  if (live.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.replaceChildren();

  const heading = document.createElement("h2");
  heading.textContent = `${live.length} tabs known only by their URL`;

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Never loaded, so Chrome has no title for them, and never read, so there " +
    "is no page text either. Clustering them by meaning would be guesswork — " +
    "every item on a site looks the same through a URL — so they are grouped " +
    "by site instead.";

  // The section says reading them fixes it, so it has to offer to do that.
  // These are not the same set as the discarded-tab backlog: a tab restored
  // from a session but never opened is unloaded without being discarded.
  const readAll = document.createElement("button");
  readAll.className = "ghost";
  readAll.textContent = `Read all ${live.length} — one page load each`;
  readAll.addEventListener("click", async () => {
    readAll.disabled = true;
    const { read, titleOnly, empty } = await harvestTabs(
      live.map((t) => ({ id: t.id, url: t.url })),
      state!.records,
    );
    lastHarvest =
      `Read ${read} tabs` +
      (titleOnly > 0 ? ` (${titleOnly} title only)` : "") +
      (empty > 0 ? `; ${empty} had nothing to read` : "") +
      ".";
    setProgress(`${lastHarvest} Re-clustering…`, null);
    await run();
  });

  host.append(heading, note, readAll);

  const byHost = new Map<string, TriageTab[]>();
  for (const tab of live) {
    const key = tab.host ?? "other";
    if (!byHost.has(key)) byHost.set(key, []);
    byHost.get(key)!.push(tab);
  }

  for (const [site, siteTabs] of [...byHost].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const box = document.createElement("div");
    box.className = "dupe-group";

    const header = document.createElement("div");
    header.className = "cluster-header";
    const name = document.createElement("span");
    name.className = "cluster-name";
    name.textContent = site;
    const meta = document.createElement("span");
    meta.className = "cluster-meta";
    meta.textContent = `${siteTabs.length} tab${siteTabs.length === 1 ? "" : "s"}`;

    const closeAll = document.createElement("button");
    closeAll.className = "ghost small";
    closeAll.textContent = "Close all";
    closeAll.addEventListener("click", () => {
      const ids = siteTabs.map((t) => t.id);
      void removeTabs(ids).then(() => {
        for (const id of ids) unidentifiedClosed.add(id);
        render();
      });
    });

    header.append(name, meta, closeAll);
    box.append(header);
    for (const tab of siteTabs) box.append(renderTab(tab));
    host.append(box);
  }
}

/** Ids closed out of the unidentified list, which has no leaf indices. */
const unidentifiedClosed = new Set<number>();

function renderDuplicates() {
  const host = el("dupes");
  // A set stops being a duplicate set once all but one of it has been closed.
  const groups = (state?.dupeGroups ?? [])
    .map((group) => group.filter((i) => !state!.removed.has(i)))
    .filter((group) => group.length > 1);

  if (!state || groups.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.replaceChildren();

  const heading = document.createElement("h2");
  const total = groups.reduce((sum, g) => sum + g.length - 1, 0);
  heading.textContent = `${total} near-duplicate tabs in ${groups.length} sets`;

  const unread = state.tabs.filter(
    (t, i) => !state!.removed.has(i) && !hasReadableContent(state!.records.get(t.url)),
  ).length;

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Matched on the page's own text rather than its URL, so the same story on " +
    "three sites counts." +
    (unread > 0
      ? ` ${unread} tabs are excluded because their page has not been read; ` +
        "title and URL alone make every item on a site look alike."
      : "");

  const keepAll = document.createElement("button");
  keepAll.className = "ghost small";
  keepAll.textContent = "Keep newest of each";
  keepAll.addEventListener("click", () => {
    const doomed: number[] = [];
    for (const group of groups) {
      const sorted = group
        .map((i) => state!.tabs[i])
        .sort((a, b) => a.idleMs - b.idleMs);
      doomed.push(...sorted.slice(1).map((t) => t.id));
    }
    void closeAndRefresh(doomed);
  });

  host.append(heading, note, keepAll);
  for (const group of groups) {
    const box = document.createElement("div");
    box.className = "dupe-group";
    for (const index of group) box.append(renderTab(state.tabs[index]));
    host.append(box);
  }
}

function renderSelection() {
  if (!state) return;
  const footer = el("selection");
  const count = state.selected.size;
  footer.hidden = count === 0;
  el("selection-count").textContent = `${count} tab${count === 1 ? "" : "s"} selected`;
}

// ===== Export =====

/**
 * The current view as data, for judging clustering quality outside the browser.
 * Membership is the thing worth inspecting: a label can read plausibly over a
 * cluster that makes no sense.
 */
function exportSnapshot() {
  if (!state) return { tabs: 0, clusters: [] };
  const threshold = currentThreshold();
  const context: RenderContext = {
    members: collectMembers(state.merges, state.tabs.length),
    dupeIndices: new Set(state.dupeGroups.flat()),
  };
  const ranked = rank(
    cutTreeInconsistent(
      state.merges,
      state.tabs.length,
      threshold,
      state.maxScores,
      context.members,
    ),
    context,
  );

  return {
    generated: new Date().toISOString(),
    tabs: state.tabs.length - state.removed.size,
    threshold,
    withMeta: state.withMeta,
    clusters: ranked.map((entry) => ({
      label: entry.label,
      size: entry.tabs.length,
      idleDays: Math.round(medianIdleDays(entry.tabs)),
      duplicates: entry.dupes,
      tabs: entry.tabs.map((t) => ({
        title: t.title,
        url: t.url,
        host: t.host,
        heading: t.heading,
        idleDays: Math.round(idleDays(t)),
        tags: t.tags,
      })),
    })),
    unidentified: state.unidentified
      .filter((t) => !unidentifiedClosed.has(t.id))
      .map((t) => ({ title: t.title, url: t.url, host: t.host })),
    nearDuplicates: state.dupeGroups.map((group) =>
      group.map((i) => ({ title: state!.tabs[i].title, url: state!.tabs[i].url })),
    ),
  };
}

async function copyOut(text: string, button: HTMLElement) {
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// ===== Wiring =====

/** Every visible cluster node, so "collapse all" reaches sub-clusters too. */
function visibleClusterNodes(): number[] {
  if (!state) return [];
  const members = collectMembers(state.merges, state.tabs.length);
  const out: number[] = [];
  const walk = (clusters: CutCluster[]) => {
    for (const cluster of clusters) {
      if (cluster.leaves.length < 2) continue;
      out.push(cluster.node);
      if (cluster.leaves.length < MIN_SUBCLUSTER_PARENT) continue;
      const subs = subCut(
        state!.merges,
        state!.tabs.length,
        cluster.node,
        subCutThreshold(state!.merges, state!.tabs.length, cluster.node, SUB_CUT_QUANTILE),
        members,
      );
      if (subs && subs.length > 1) walk(subs);
    }
  };
  walk(
    cutTreeInconsistent(
      state.merges,
      state.tabs.length,
      currentThreshold(),
      state.maxScores,
      members,
    ),
  );
  return out;
}

function updateFoldAllLabel() {
  el("fold-all").textContent =
    state && state.collapsed.size > 0 ? "Expand all" : "Collapse all";
}

el("fold-all").addEventListener("click", () => {
  if (!state) return;
  if (state.collapsed.size > 0) state.collapsed.clear();
  else for (const node of visibleClusterNodes()) state.collapsed.add(node);
  render();
});

// Tabs closed from the tab strip while this page is open drop out of the view
// the same way, so it never offers to close something that is already gone.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!state) return;
  forgetTabs([tabId]);
  scheduleRender();
});

el("copy-json").addEventListener("click", (e) => {
  void copyOut(
    JSON.stringify(exportSnapshot(), null, 2),
    e.currentTarget as HTMLElement,
  );
});

el("cut").addEventListener("input", scheduleRender);
el("rescan").addEventListener("click", () => void run());
el("selection-clear").addEventListener("click", () => {
  state?.selected.clear();
  render();
});
el("selection-close").addEventListener("click", () => {
  if (state) void closeAndRefresh([...state.selected]);
});

void run();
