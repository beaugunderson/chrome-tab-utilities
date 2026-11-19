import { parse as parseTld } from "tldts";
import { type PageMeta, hasMetaContent, isRealTitle } from "../lib/features";
import { type DiscardPolicy, selectDiscardCandidates } from "../lib/discard";
import { type PrState, readPrStateInPage } from "../lib/github";
import { type TabRecord, patchRecord } from "../lib/store";
import { type SourceGroup, colorForDomain, planGroupMerge } from "../lib/groups";
import { removeTabs } from "../lib/tabs";
import { domainKey } from "../lib/url";

const MIN_TABS = 4;
const IGNORE_PINNED = true;
const AUTO_COLLAPSE = true;
const MOVE_TO_END = false;
const DEBOUNCE_MS = 200;
const BADGE_DEBOUNCE_MS = 500;
const BADGE_COLOR = "#764BA2";
const TAB_GROUP_ID_NONE = -1;

// Auto-discard settings (hardcoded; mirror Great-er Discarder-er behavior).
const DISCARD_AFTER_MINUTES = 60;
const DISCARD_IGNORE_PINNED = true;
const DISCARD_IGNORE_AUDIBLE = true;
const DISCARD_PAUSE_WHEN_OFFLINE = true;
// Hosts that start with any of these prefixes are never auto-discarded.
const DISCARD_HOST_PREFIX_DENYLIST = ["archive."];
const DISCARD_SWEEP_ALARM = "discard-sweep";
const DISCARD_SWEEP_EVERY_MINUTES = 1;
const DISCARD_SWEEP_CONCURRENCY = 12;

// Which GitHub owners the stale-tab sweep applies to. Set on the options page
// and stored in chrome.storage.sync; empty until configured.
const GITHUB_STALE_ORGS_KEY = "githubStaleOrgs";
// Discarded PR tabs are reloaded so their state can be read from the DOM;
// cap how long we wait for each reload before giving up on that tab.
const GITHUB_TAB_LOAD_TIMEOUT_MS = 20000;
const GITHUB_RELOAD_CONCURRENCY = 8;

export default defineBackground(() => {
  browser.commands.onCommand.addListener(async (command) => {
    if (command === "copy-tabs") {
      await copyTabs();
    } else if (command === "paste-tabs") {
      await pasteTabs();
    } else if (command === "group-tabs-by-domain") {
      await groupAllTabsByDomain();
    } else if (command === "close-duplicate-tabs") {
      await closeDuplicateTabs();
    } else if (command === "merge-all-windows") {
      await mergeAllWindows();
    } else if (command === "new-window-with-current-and-tabs-to-right") {
      await newWindowWithTabsToRight(true);
    } else if (command === "new-window-with-tabs-to-right") {
      await newWindowWithTabsToRight(false);
    } else if (command === "sort-tabs-by-url") {
      await sortTabsInCurrentWindow("url");
    } else if (command === "sort-tabs-by-title") {
      await sortTabsInCurrentWindow("title");
    } else if (command === "close-stale-github-tabs") {
      await closeStaleGithubTabs();
    } else if (command === "triage-tabs") {
      await openTriagePage();
    }
  });

  setupTabSignals();

  // Map key is `${windowId}:${domain}` so timers for different windows
  // don't stomp on each other.
  const pendingByDomain = new Map<string, ReturnType<typeof setTimeout>>();

  const scheduleDomainGrouping = (tab: chrome.tabs.Tab, url?: string) => {
    if (IGNORE_PINNED && tab.pinned) return;
    const resolvedUrl = url ?? tab.url;
    if (!resolvedUrl || tab.windowId === undefined) return;
    const domain = domainKey(resolvedUrl);
    if (!domain) return;

    const key = `${tab.windowId}:${domain}`;
    const existing = pendingByDomain.get(key);
    if (existing) clearTimeout(existing);
    const windowId = tab.windowId;
    pendingByDomain.set(
      key,
      setTimeout(() => {
        pendingByDomain.delete(key);
        void groupDomainInWindow(windowId, domain);
      }, DEBOUNCE_MS),
    );
  };

  // onCreated fires for session-restored tabs, "reopen closed tab", and any
  // tab born with a URL already set — cases where onUpdated/changeInfo.url
  // never fires because the URL was never "changed."
  chrome.tabs.onCreated.addListener((tab) => scheduleDomainGrouping(tab));
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    scheduleDomainGrouping(tab, changeInfo.url);
  });

  // Duplicate-count badge. Gate onUpdated on `changeInfo.url` so we don't
  // re-scan on every favicon/title/status change.
  chrome.tabs.onCreated.addListener(() => scheduleBadgeUpdate());
  chrome.tabs.onRemoved.addListener(() => scheduleBadgeUpdate());
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    if (changeInfo.url) scheduleBadgeUpdate();
  });
  chrome.runtime.onStartup.addListener(() => void updateDuplicateBadge());
  chrome.runtime.onInstalled.addListener(() => void updateDuplicateBadge());
  void updateDuplicateBadge();

  // Popup (`action.default_popup`) dispatches user-chosen actions via message.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void handlePopupMessage(msg, sender).then(sendResponse);
    return true; // keep channel open for async response
  });

  setupAutoDiscard();
});

type PopupAction =
  | "copy-tabs"
  | "paste-tabs"
  | "group-tabs-by-domain"
  | "close-duplicate-tabs"
  | "merge-all-windows"
  | "new-window-with-current-and-tabs-to-right"
  | "new-window-with-tabs-to-right"
  | "sort-tabs-by-url"
  | "sort-tabs-by-title"
  | "close-stale-github-tabs"
  | "triage-tabs"
  | "get-counts";

interface PopupMessage {
  type: PopupAction;
}

/** Page metadata pushed by the content script on every page load. */
interface PageMetaMessage {
  type: "page-meta";
  url: string;
  title?: string;
  meta: PageMeta;
}

async function handlePopupMessage(
  msg: PopupMessage | unknown,
  sender?: chrome.runtime.MessageSender,
) {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return;

  if ((msg as PageMetaMessage).type === "page-meta") {
    const { title, meta } = msg as PageMetaMessage;
    // Keyed by the tab's URL, not the one the page reports. A page that
    // redirects reports where it landed, and filing the result there leaves
    // the tab's own record empty: read successfully, stored under an address
    // nothing looks up, and still counted as never read.
    const url = sender?.tab?.url ?? (msg as PageMetaMessage).url;
    const patch: Partial<TabRecord> = {};
    // An empty payload only means the page had nothing; storing it would look
    // like the page had been read.
    if (hasMetaContent(meta)) patch.meta = meta;
    if (isRealTitle(title, url)) patch.title = title;
    if (Object.keys(patch).length > 0) await patchRecord(url, patch);
    return { ok: true };
  }

  const { type } = msg as PopupMessage;
  switch (type) {
    case "copy-tabs":
      await copyTabs();
      return { ok: true };
    case "paste-tabs":
      await pasteTabs();
      return { ok: true };
    case "group-tabs-by-domain":
      await groupAllTabsByDomain();
      return { ok: true };
    case "close-duplicate-tabs":
      await closeDuplicateTabs();
      return { ok: true };
    case "merge-all-windows":
      await mergeAllWindows();
      return { ok: true };
    case "new-window-with-current-and-tabs-to-right":
      await newWindowWithTabsToRight(true);
      return { ok: true };
    case "new-window-with-tabs-to-right":
      await newWindowWithTabsToRight(false);
      return { ok: true };
    case "sort-tabs-by-url":
      await sortTabsInCurrentWindow("url");
      return { ok: true };
    case "sort-tabs-by-title":
      await sortTabsInCurrentWindow("title");
      return { ok: true };
    case "close-stale-github-tabs":
      return { ok: true, closed: await closeStaleGithubTabs() };
    case "triage-tabs":
      await openTriagePage();
      return { ok: true };
    case "get-counts":
      return await getCounts();
  }
}

// ===== Tab signals for triage =====

// Chrome discards openerTabId on restart and resets lastAccessed, so both are
// snapshotted per URL. The opener graph in particular is the strongest
// same-task signal available and there is no way to recover it after the fact.

function setupTabSignals() {
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.openerTabId === undefined || !tab.id) return;
    const openerTabId = tab.openerTabId;
    const tabId = tab.id;
    // The new tab usually has no URL yet, so wait for its first committed one
    // and pair that with the opener's URL.
    const onUpdated = (
      updatedId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
    ) => {
      if (updatedId !== tabId || !changeInfo.url) return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      void chrome.tabs
        .get(openerTabId)
        .then((opener) => {
          if (opener.url) {
            return patchRecord(changeInfo.url!, { opener: opener.url });
          }
        })
        .catch(() => {
          // Opener already closed; the relationship is simply unavailable.
        });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.url) return patchRecord(tab.url, { seen: Date.now() });
      })
      .catch(() => {});
  });
}

/** Focus an existing triage tab rather than piling up duplicates. */
async function openTriagePage() {
  const url = chrome.runtime.getURL("triage.html");
  // The page records which card is showing in its query string, and a match
  // pattern without the wildcard matches the bare URL only — so an open triage
  // tab that has dealt a single card would not be found, and a second one
  // would open next to it.
  const [existing] = await chrome.tabs.query({ url: `${url}*` });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url });
}

async function getCounts() {
  const [tabs, windows, currentWindow] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({ populate: false }),
    chrome.windows.getCurrent(),
  ]);
  let duplicates = 0;
  for (const group of groupTabsByDedupKey(tabs).values()) {
    if (group.length > 1) duplicates += group.length - 1;
  }
  // Only windows in the same profile can be merged (tabs can't cross the
  // incognito/normal boundary), so count within the current window's profile.
  const mergeable = windows.filter(
    (w) => w.type === "normal" && w.incognito === currentWindow.incognito,
  ).length;
  let discarded = 0;
  for (const t of tabs) if (t.discarded) discarded++;
  const live = tabs.length - discarded;
  return {
    duplicates,
    windows: mergeable,
    tabs: tabs.length,
    live,
    discarded,
  };
}

async function copyTabs() {
  const currentWindow = await browser.windows.getCurrent();
  const allTabs = await browser.tabs.query({ windowId: currentWindow.id });
  const highlightedTabs = allTabs.filter((tab) => tab.highlighted);

  const tabsToCopy = highlightedTabs.length > 1 ? highlightedTabs : allTabs;
  const urls = tabsToCopy.map((tab) => tab.url).filter(Boolean);
  const text = urls.join("\n");

  await writeToClipboard(text);
}

async function pasteTabs() {
  const text = await readFromClipboard();
  if (!text) return;

  const urls = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("http://") || line.startsWith("https://"));

  for (const url of urls) {
    await browser.tabs.create({ url });
  }
}

async function writeToClipboard(text: string) {
  await ensureOffscreenDocument();

  await chrome.runtime.sendMessage({
    type: "clipboard-write",
    text,
  });

  await chrome.offscreen.closeDocument();
}

async function readFromClipboard(): Promise<string> {
  await ensureOffscreenDocument();

  const text = await chrome.runtime.sendMessage({
    type: "clipboard-read",
  });

  await chrome.offscreen.closeDocument();

  return text;
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.CLIPBOARD],
    justification: "Read/write clipboard for tab URL copy/paste",
  });
}

// Group ops race with group deletion: Chrome auto-deletes a group when its
// last tab is closed, which can happen between a query and the follow-up
// update/group call.
function isMissingGroupError(e: unknown): boolean {
  return e instanceof Error && /No group with id/.test(e.message);
}

async function groupAllTabsByDomain() {
  const windowId = chrome.windows.WINDOW_ID_CURRENT;
  const queryInfo: chrome.tabs.QueryInfo = IGNORE_PINNED
    ? { windowId, pinned: false }
    : { windowId };

  const [tabs, existingGroups] = await Promise.all([
    chrome.tabs.query(queryInfo),
    chrome.tabGroups.query({ windowId }),
  ]);

  const activeTab = tabs.find((t) => t.active);
  const existingByTitle = new Map<string, chrome.tabGroups.TabGroup>();
  for (const g of existingGroups) {
    if (g.title) existingByTitle.set(g.title.toUpperCase(), g);
  }

  // Bucket tabs by domain. Track ungrouped ids separately so we only move
  // tabs that need moving (avoids needless chrome.tabs.group churn).
  type Bucket = { all: number[]; ungrouped: number[] };
  const buckets = new Map<string, Bucket>();
  for (const t of tabs) {
    if (!t.id || !t.url) continue;
    const key = domainKey(t.url);
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { all: [], ungrouped: [] };
      buckets.set(key, bucket);
    }
    bucket.all.push(t.id);
    const existing = existingByTitle.get(key);
    if (!existing || t.groupId !== existing.id) bucket.ungrouped.push(t.id);
  }

  const touchedGroupIds = new Set<number>();
  const createdGroupIds: number[] = [];

  // Fire group moves in parallel. Each domain is one chrome.tabs.group call.
  await Promise.all(
    Array.from(buckets.entries()).map(async ([key, bucket]) => {
      const existing = existingByTitle.get(key);
      if (existing) {
        touchedGroupIds.add(existing.id);
        const color = colorForDomain(key);
        if (existing.color !== color) {
          await chrome.tabGroups.update(existing.id, { color });
        }
        if (bucket.ungrouped.length === 0) return;
        try {
          await chrome.tabs.group({
            tabIds: bucket.ungrouped as [number, ...number[]],
            groupId: existing.id,
          });
          return;
        } catch (e) {
          // Group was deleted between query and update — fall through to
          // recreate it from `bucket.all`.
          if (!isMissingGroupError(e)) throw e;
        }
      }
      if (bucket.all.length < MIN_TABS) return;
      const groupId = await chrome.tabs.group({
        tabIds: bucket.all as [number, ...number[]],
      });
      createdGroupIds.push(groupId);
      touchedGroupIds.add(groupId);
      await chrome.tabGroups.update(groupId, {
        title: key,
        color: colorForDomain(key),
        collapsed: AUTO_COLLAPSE,
      });
    }),
  );

  if (AUTO_COLLAPSE) {
    const afterGroups = await chrome.tabGroups.query({ windowId });
    await Promise.all(
      afterGroups
        .filter(
          (g) =>
            !g.collapsed &&
            // keep the group containing the active tab expanded so we don't
            // force-switch the user's active tab
            !(activeTab && activeTab.groupId === g.id),
        )
        .map((g) => chrome.tabGroups.update(g.id, { collapsed: true })),
    );
  }

  if (MOVE_TO_END) {
    await Promise.all(
      createdGroupIds.map((id) => chrome.tabGroups.move(id, { index: -1 })),
    );
  }
}

type SortMode = "url" | "title";

async function sortTabsInCurrentWindow(mode: SortMode) {
  const win = await chrome.windows.getLastFocused();
  if (win.id === undefined) return;
  const windowId = win.id;

  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);

  const pinnedCount = tabs.filter((t) => t.pinned).length;

  // Groups sorted alphabetically (A→Z) — the original's reverse default was
  // confusing, and the SLD-based title ordering already naturally clusters
  // related work.
  const sortedGroups = [...groups].sort((a, b) =>
    (a.title ?? "").localeCompare(b.title ?? ""),
  );

  let offset = pinnedCount;

  // Re-layout each group at the running offset, then sort tabs within it.
  // `chrome.tabs.move` can detach tabs from their group, so we re-group
  // afterwards with the same groupId.
  for (const g of sortedGroups) {
    const groupTabs = tabs
      .filter((t) => t.groupId === g.id && t.id !== undefined)
      .sort(tabComparator(mode));
    if (groupTabs.length === 0) continue;

    await chrome.tabGroups.move(g.id, { index: offset });

    const ids = groupTabs.map((t) => t.id!) as [number, ...number[]];
    await chrome.tabs.move(ids, { index: offset });
    await chrome.tabs.group({ tabIds: ids, groupId: g.id });

    offset += groupTabs.length;
  }

  // Ungrouped (and unpinned) tabs get sorted at the end.
  const ungrouped = tabs
    .filter(
      (t) =>
        !t.pinned && t.groupId === TAB_GROUP_ID_NONE && t.id !== undefined,
    )
    .sort(tabComparator(mode));
  if (ungrouped.length > 0) {
    const ids = ungrouped.map((t) => t.id!) as [number, ...number[]];
    await chrome.tabs.move(ids, { index: offset });
  }
}

function tabComparator(mode: SortMode) {
  return (a: chrome.tabs.Tab, b: chrome.tabs.Tab) => {
    if (mode === "title") {
      return (a.title ?? "").localeCompare(
        b.title ?? "",
        undefined,
        { sensitivity: "base" },
      );
    }
    return urlSortKey(a.url).localeCompare(urlSortKey(b.url));
  };
}

function urlSortKey(url: string | undefined): string {
  if (!url) return "￿"; // empty urls go last
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const parsed = parseTld(u.hostname);
  const sld = (parsed?.domainWithoutSuffix ?? u.hostname).toLowerCase();
  const sub = (parsed?.subdomain ?? "").toLowerCase();
  // NUL separators keep component boundaries distinct during localeCompare.
  return `${sld}\0${sub}\0${u.pathname}\0${u.search}\0${u.hash}`;
}

async function newWindowWithTabsToRight(includeCurrent: boolean) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (
    !activeTab ||
    activeTab.index === undefined ||
    activeTab.windowId === undefined
  )
    return;

  const tabsInWindow = await chrome.tabs.query({ windowId: activeTab.windowId });
  const startIndex = includeCurrent ? activeTab.index : activeTab.index + 1;
  const toMove = tabsInWindow
    .filter((t) => t.id !== undefined && t.index >= startIndex)
    .sort((a, b) => a.index - b.index);

  if (toMove.length === 0) return;

  // Clone source group metadata so we can re-create groups in the new window.
  const sourceGroupMeta = new Map<
    number,
    { title?: string; color?: chrome.tabGroups.TabGroup["color"] }
  >();
  const uniqueGroupIds = Array.from(
    new Set(
      toMove
        .map((t) => t.groupId)
        .filter((g): g is number => g !== undefined && g !== TAB_GROUP_ID_NONE),
    ),
  );
  await Promise.all(
    uniqueGroupIds.map(async (gid) => {
      try {
        const g = await chrome.tabGroups.get(gid);
        sourceGroupMeta.set(gid, { title: g.title, color: g.color });
      } catch {
        // Group gone — ignore.
      }
    }),
  );

  // Create the new window seeded with the first tab. The rest follow via
  // tabs.move, which is batched and preserves intended order.
  const firstTab = toMove[0];
  const newWindow = await chrome.windows.create({ tabId: firstTab.id });
  if (newWindow?.id === undefined) return;

  if (toMove.length > 1) {
    const restIds = toMove.slice(1).map((t) => t.id!) as [number, ...number[]];
    await chrome.tabs.move(restIds, { windowId: newWindow.id, index: -1 });
  }

  // Re-group tabs that were in a group in the source window.
  const byGroup = new Map<number, number[]>();
  for (const t of toMove) {
    const gid = t.groupId ?? TAB_GROUP_ID_NONE;
    if (gid === TAB_GROUP_ID_NONE) continue;
    let bucket = byGroup.get(gid);
    if (!bucket) {
      bucket = [];
      byGroup.set(gid, bucket);
    }
    bucket.push(t.id!);
  }
  for (const [sourceGid, tabIds] of byGroup) {
    if (tabIds.length === 0) continue;
    const newGroupId = await chrome.tabs.group({
      tabIds: tabIds as [number, ...number[]],
      createProperties: { windowId: newWindow.id },
    });
    const meta = sourceGroupMeta.get(sourceGid);
    if (meta) {
      await chrome.tabGroups.update(newGroupId, {
        title: meta.title,
        color: meta.color,
      });
    }
  }

  // Restore pinned state after moves settle.
  await Promise.all(
    toMove
      .filter((t) => t.pinned)
      .map((t) => chrome.tabs.update(t.id!, { pinned: true })),
  );
}

async function mergeAllWindows() {
  const currentWindow = await chrome.windows.getCurrent();
  const targetWindowId = currentWindow.id;
  if (targetWindowId === undefined) return;

  const windows = await chrome.windows.getAll({ populate: true });

  // Collect tabs from non-target normal windows, bucketed by group.
  type TabMove = { tab: chrome.tabs.Tab; sourceGroupId: number };
  const ungrouped: TabMove[] = [];
  const grouped = new Map<number, TabMove[]>(); // keyed by source groupId
  const sourceGroupMeta = new Map<
    number,
    { title?: string; color?: chrome.tabGroups.TabGroup["color"] }
  >();

  for (const w of windows) {
    if (w.id === targetWindowId) continue;
    if (w.type !== "normal") continue; // skip popup/devtools/panel
    if (w.incognito !== currentWindow.incognito) continue; // can't move tabs across the incognito/normal profile boundary
    if (!w.tabs) continue;
    for (const tab of w.tabs) {
      if (tab.id === undefined) continue;
      const gid = tab.groupId ?? TAB_GROUP_ID_NONE;
      if (gid === TAB_GROUP_ID_NONE) {
        ungrouped.push({ tab, sourceGroupId: gid });
      } else {
        let bucket = grouped.get(gid);
        if (!bucket) {
          bucket = [];
          grouped.set(gid, bucket);
        }
        bucket.push({ tab, sourceGroupId: gid });
      }
    }
  }

  // Fetch source group metadata in parallel so we can clone title/color.
  await Promise.all(
    Array.from(grouped.keys()).map(async (gid) => {
      try {
        const g = await chrome.tabGroups.get(gid);
        sourceGroupMeta.set(gid, { title: g.title, color: g.color });
      } catch {
        // Group gone — ignore.
      }
    }),
  );

  // Move ungrouped tabs in one batched call.
  if (ungrouped.length > 0) {
    const ids = ungrouped.map((t) => t.tab.id!) as [number, ...number[]];
    await chrome.tabs.move(ids, { windowId: targetWindowId, index: -1 });
  }

  // Move grouped tabs into the target window, one group per title: tabs join
  // the target's group of that title when it has one, and same-titled source
  // groups share a single new group. `chrome.tabs.group` moves tabs into the
  // group's window as part of grouping.
  const sourceGroups: SourceGroup[] = Array.from(grouped, ([gid, bucket]) => ({
    ...sourceGroupMeta.get(gid),
    tabIds: bucket.map((t) => t.tab.id!),
  }));
  const plan = planGroupMerge(
    await chrome.tabGroups.query({ windowId: targetWindowId }),
    sourceGroups,
  );
  for (const join of plan.joins) {
    await chrome.tabs.group({
      tabIds: join.tabIds as [number, ...number[]],
      groupId: join.groupId,
    });
  }
  for (const create of plan.creates) {
    const newGroupId = await chrome.tabs.group({
      tabIds: create.tabIds as [number, ...number[]],
      createProperties: { windowId: targetWindowId },
    });
    await chrome.tabGroups.update(newGroupId, {
      title: create.title,
      color: create.color,
    });
  }

  // Re-pin tabs that were pinned in their source window. Chrome drops the
  // pinned flag during cross-window moves; restore it after all moves settle.
  const pinnedRestore = [...ungrouped, ...Array.from(grouped.values()).flat()]
    .filter((t) => t.tab.pinned && t.tab.id !== undefined)
    .map((t) => chrome.tabs.update(t.tab.id!, { pinned: true }));
  await Promise.all(pinnedRestore);

  await groupAllTabsByDomain();
  await sortTabsInCurrentWindow("url");
}

async function closeDuplicateTabs() {
  const tabs = await chrome.tabs.query({});
  const toClose = findDuplicateTabIdsToClose(tabs);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await updateDuplicateBadge();
}

function findDuplicateTabIdsToClose(tabs: chrome.tabs.Tab[]): number[] {
  const byKey = groupTabsByDedupKey(tabs);
  const toClose: number[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    // Winner: active tab if any, else most-recently-accessed.
    const winner =
      group.find((t) => t.active) ??
      group.reduce((best, t) =>
        (t.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ? t : best,
      );
    for (const t of group) {
      if (t.id !== undefined && t.id !== winner.id) toClose.push(t.id);
    }
  }
  return toClose;
}

function groupTabsByDedupKey(
  tabs: chrome.tabs.Tab[],
): Map<string, chrome.tabs.Tab[]> {
  const byKey = new Map<string, chrome.tabs.Tab[]>();
  for (const t of tabs) {
    if (t.pinned) continue;
    const key = normalizeUrlForDedup(t.url);
    if (!key) continue;
    let arr = byKey.get(key);
    if (!arr) {
      arr = [];
      byKey.set(key, arr);
    }
    arr.push(t);
  }
  return byKey;
}

let badgeTimer: ReturnType<typeof setTimeout> | null = null;
let lastBadgeText = "";

function scheduleBadgeUpdate() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    void updateDuplicateBadge();
  }, BADGE_DEBOUNCE_MS);
}

async function updateDuplicateBadge() {
  const tabs = await chrome.tabs.query({});
  const byKey = groupTabsByDedupKey(tabs);
  let dupes = 0;
  for (const group of byKey.values()) {
    if (group.length > 1) dupes += group.length - 1;
  }
  // Chrome truncates badge text to ~4 chars; cap visibly.
  const text = dupes === 0 ? "" : dupes > 999 ? "999+" : String(dupes);
  if (text === lastBadgeText) return;
  lastBadgeText = text;
  await chrome.action.setBadgeText({ text });
  if (text !== "") {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  }
}

function normalizeUrlForDedup(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // Hostname is case-insensitive; everything else is treated as-is.
  const host = u.hostname.toLowerCase();
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${u.protocol}//${host}${u.port ? ":" + u.port : ""}${path}${u.search}${u.hash}`;
}

async function groupDomainInWindow(windowId: number, domain: string) {
  const existingGroups = await chrome.tabGroups.query({
    windowId,
    title: domain,
  });
  const existing = existingGroups[0];

  const queryInfo: chrome.tabs.QueryInfo = IGNORE_PINNED
    ? { windowId, pinned: false }
    : { windowId };
  const tabs = await chrome.tabs.query(queryInfo);

  const matchingIds: number[] = [];
  const toMove: number[] = [];
  for (const t of tabs) {
    if (!t.id || !t.url) continue;
    if (domainKey(t.url) !== domain) continue;
    matchingIds.push(t.id);
    if (!existing || t.groupId !== existing.id) toMove.push(t.id);
  }

  if (matchingIds.length === 0) return;

  if (existing) {
    if (toMove.length === 0) return;
    try {
      await chrome.tabs.group({
        tabIds: toMove as [number, ...number[]],
        groupId: existing.id,
      });
      return;
    } catch (e) {
      // Group was deleted between query and update — fall through to
      // recreate it from `matchingIds`.
      if (!isMissingGroupError(e)) throw e;
    }
  }

  if (matchingIds.length < MIN_TABS) return;

  // Name the window: without it Chrome creates the group in the focused
  // window and moves the tabs there.
  const groupId = await chrome.tabs.group({
    tabIds: matchingIds as [number, ...number[]],
    createProperties: { windowId },
  });
  // Leave the newly-created group expanded — the user just opened a tab that
  // crossed MIN_TABS, so collapsing the group they're actively working in is
  // disruptive. Other groups still get collapsed below per AUTO_COLLAPSE.
  await chrome.tabGroups.update(groupId, {
    title: domain,
    color: colorForDomain(domain),
  });

  if (AUTO_COLLAPSE) {
    const others = await chrome.tabGroups.query({ windowId });
    await Promise.all(
      others
        .filter((g) => g.id !== groupId && !g.collapsed)
        .map((g) => chrome.tabGroups.update(g.id, { collapsed: true })),
    );
  }

  if (MOVE_TO_END) {
    await chrome.tabGroups.move(groupId, { index: -1 });
  }
}

// ===== Stale GitHub tab cleanup =====

type GithubTabKind = "pulls" | "actions-run" | "pr" | null;

// Reads the configured owners, lowercased because GitHub treats the owner path
// segment case-insensitively.
async function getGithubStaleOrgs(): Promise<string[]> {
  const stored = await chrome.storage.sync.get(GITHUB_STALE_ORGS_KEY);
  const orgs: unknown = stored[GITHUB_STALE_ORGS_KEY];
  if (!Array.isArray(orgs)) return [];
  return orgs.map((org: string) => org.toLowerCase());
}

// Closes, for each configured owner: every /pulls list page and
// /actions/runs/<id> page outright, plus /pull/<n> tabs whose PR is merged or
// closed. PR state is read straight from the tab's DOM (no gh/API calls);
// discarded tabs are reloaded first so they have a DOM to read.
async function closeStaleGithubTabs(): Promise<number> {
  const orgs = await getGithubStaleOrgs();
  // With no owners configured the sweep can't match anything, so open the
  // options page instead of silently doing nothing.
  if (orgs.length === 0) {
    await chrome.runtime.openOptionsPage();
    return 0;
  }

  const tabs = await chrome.tabs.query({});

  // A Set because reloading discarded tabs can hand a tab a new id (see
  // ensureTabLoaded), and we never want the same tab queued twice.
  const toClose = new Set<number>();
  const prTabs: chrome.tabs.Tab[] = [];
  for (const t of tabs) {
    if (t.id === undefined) continue;
    const kind = classifyGithubTab(t.url, orgs);
    if (kind === "pulls" || kind === "actions-run") {
      toClose.add(t.id);
    } else if (kind === "pr") {
      prTabs.push(t);
    }
  }

  // Read PR state from each tab's DOM, reloading discarded tabs first. A
  // discarded tab is already unloaded, so reloading it can't lose an in-flight
  // draft review comment; loaded tabs are read in place and never reloaded.
  // readPrState returns the tab's *live* id, which may differ from its
  // pre-reload id if Chrome replaced the discarded tab.
  const prStates = await mapWithConcurrency(
    prTabs,
    GITHUB_RELOAD_CONCURRENCY,
    (tab) => readPrState(tab),
  );
  for (const { id, state } of prStates) {
    if (state === "closed") toClose.add(id);
  }

  return removeTabs([...toClose]);
}

// Closes each tab independently so one already-gone id can't abort the batch.
// chrome.tabs.remove([...ids]) rejects the *entire* array if any single id is
// stale (a tab the user closed mid-sweep, or a discarded tab whose id changed
// on reload), which would otherwise close nothing and throw uncaught. Returns
// the number actually closed.
function classifyGithubTab(
  url: string | undefined,
  orgs: string[],
): GithubTabKind {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "github.com") return null;

  const segments = u.pathname.split("/").filter(Boolean); // [org, repo, ...]
  const org = segments[0]?.toLowerCase();
  if (!org || !orgs.includes(org)) return null;

  // /org/repo/pulls (and filtered views like /pulls/assigned)
  if (segments[2] === "pulls") return "pulls";
  // /org/repo/actions/runs/<id>
  if (segments[2] === "actions" && segments[3] === "runs" && segments[4]) {
    return "actions-run";
  }
  // /org/repo/pull/<n>
  if (segments[2] === "pull" && /^\d+$/.test(segments[3] ?? "")) return "pr";

  return null;
}

interface PrStateResult {
  id: number;
  state: PrState;
}

async function readPrState(tab: chrome.tabs.Tab): Promise<PrStateResult> {
  const initialId = tab.id;
  if (initialId === undefined) return { id: -1, state: "unknown" };
  try {
    // ensureTabLoaded returns the tab's live id, which can differ from
    // initialId when reloading a discarded tab causes Chrome to replace it.
    // Injecting against the live id is what makes discarded PRs readable.
    const tabId = await ensureTabLoaded(tab);
    if (tabId === null) return { id: initialId, state: "unknown" };
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPrStateInPage,
    });
    const state = result?.result;
    return {
      id: tabId,
      state: state === "open" || state === "closed" ? state : "unknown",
    };
  } catch {
    // chrome:// page, injection blocked, tab gone, render not ready, etc.
    // Treat as unknown so we never close a tab we couldn't actually verify.
    return { id: initialId, state: "unknown" };
  }
}

// Resolves with the tab's live id once it's loaded enough to inject into, or
// null if the tab is gone. Discarded tabs are reloaded; merely-loading tabs are
// awaited without reload; already-complete loaded tabs return immediately.
// Reloading a discarded tab can make Chrome replace it with a new id
// (chrome.tabs.onReplaced); we track that so callers inject against the live id
// rather than the dead pre-reload one.
function ensureTabLoaded(tab: chrome.tabs.Tab): Promise<number | null> {
  const tabId = tab.id;
  if (tabId === undefined) return Promise.resolve(null);
  if (!tab.discarded && tab.status === "complete") return Promise.resolve(tabId);

  return new Promise<number | null>((resolve) => {
    let currentId = tabId;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onReplaced.removeListener(onReplaced);
      clearTimeout(timer);
      resolve(currentId);
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === currentId && info.status === "complete") finish();
    };
    const onReplaced = (addedTabId: number, removedTabId: number) => {
      if (removedTabId === currentId) currentId = addedTabId;
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onReplaced.addListener(onReplaced);
    const timer = setTimeout(finish, GITHUB_TAB_LOAD_TIMEOUT_MS);
    if (tab.discarded) chrome.tabs.reload(tabId).catch(finish);
  });
}

// Simple worker-pool map so reloading many discarded tabs doesn't fire a
// hundred simultaneous network loads.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// ===== Auto-discard =====

// One repeating alarm sweeps every tab. Chrome caps an extension at 500 active
// alarms, so a per-tab timer breaks outright on a large tab set; the sweep also
// removes all the arm/clear/re-arm bookkeeping, since every check is made
// against the tab's state at the moment it would be discarded.

function setupAutoDiscard() {
  chrome.alarms.create(DISCARD_SWEEP_ALARM, {
    periodInMinutes: DISCARD_SWEEP_EVERY_MINUTES,
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== DISCARD_SWEEP_ALARM) return;
    void sweepDiscardableTabs();
  });
}

const DISCARD_POLICY: DiscardPolicy = {
  afterMinutes: DISCARD_AFTER_MINUTES,
  ignorePinned: DISCARD_IGNORE_PINNED,
  ignoreAudible: DISCARD_IGNORE_AUDIBLE,
  hostPrefixDenylist: DISCARD_HOST_PREFIX_DENYLIST,
  pauseWhenOffline: DISCARD_PAUSE_WHEN_OFFLINE,
};

async function sweepDiscardableTabs() {
  const tabs = await chrome.tabs.query({});
  const candidates = selectDiscardCandidates(tabs, DISCARD_POLICY, {
    now: Date.now(),
    online: navigator.onLine,
  });
  if (candidates.length === 0) return;

  // The dirty-form check is a message round trip per tab, so cap how many are
  // in flight at once on a large sweep.
  await mapWithConcurrency(candidates, DISCARD_SWEEP_CONCURRENCY, async (tabId) => {
    if (await checkBeforeDiscard(tabId)) return;
    try {
      await chrome.tabs.discard(tabId);
    } catch {
      // Activated or removed between the sweep and the call.
    }
  });
}


/**
 * Ask a tab whether it holds unsaved form input, and take its page metadata
 * while the content script is still there to answer.
 *
 * Discarding is the point of no return for metadata: the script goes with the
 * page, and a discarded tab can only be read again by reloading it. On a tab
 * set where nearly everything is discarded, capturing it here is the
 * difference between the triage page clustering on real page text and
 * clustering on titles alone.
 */
async function checkBeforeDiscard(tabId: number): Promise<boolean> {
  // The round trip survives SW sleep because the content script lives in the
  // page. No listener (chrome://, file://, not yet injected) → treat as not
  // dirty, so pages that can never hold form input still get discarded.
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: "is-form-dirty",
    })) as { dirty?: boolean; url?: string; meta?: PageMeta } | undefined;
    if (response?.url && response.meta) {
      await patchRecord(response.url, { meta: response.meta });
    }
    return response?.dirty === true;
  } catch {
    return false;
  }
}
