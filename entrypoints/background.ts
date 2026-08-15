import { getDomainWithoutSuffix, parse as parseTld } from "tldts";

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
const DISCARD_ALARM_PREFIX = "discard:";
const ACTIVE_TAB_SESSION_PREFIX = "activeTab:";

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
    }
  });

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
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    void handlePopupMessage(msg).then(sendResponse);
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
  | "get-counts";

interface PopupMessage {
  type: PopupAction;
}

async function handlePopupMessage(msg: PopupMessage | unknown) {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
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
    case "get-counts":
      return await getCounts();
  }
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

function domainKey(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  const sld = getDomainWithoutSuffix(host, { allowPrivateDomains: false });
  return (sld || host).toUpperCase();
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

  // Move grouped tabs and re-group them in the target window with cloned
  // metadata. `chrome.tabs.group` with `createProperties.windowId` moves
  // tabs into the target window as part of grouping.
  for (const [sourceGid, bucket] of grouped) {
    const ids = bucket.map((t) => t.tab.id!) as [number, ...number[]];
    const newGroupId = await chrome.tabs.group({
      tabIds: ids,
      createProperties: { windowId: targetWindowId },
    });
    const meta = sourceGroupMeta.get(sourceGid);
    if (meta) {
      await chrome.tabGroups.update(newGroupId, {
        title: meta.title,
        color: meta.color,
      });
    }
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

  const groupId = await chrome.tabs.group({
    tabIds: matchingIds as [number, ...number[]],
  });
  // Leave the newly-created group expanded — the user just opened a tab that
  // crossed MIN_TABS, so collapsing the group they're actively working in is
  // disruptive. Other groups still get collapsed below per AUTO_COLLAPSE.
  await chrome.tabGroups.update(groupId, { title: domain });

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
async function removeTabs(ids: number[]): Promise<number> {
  const results = await Promise.allSettled(
    ids.map((id) => chrome.tabs.remove(id)),
  );
  return results.filter((r) => r.status === "fulfilled").length;
}

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
  state: "open" | "closed" | "unknown";
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

// Runs in the page context (no closure over extension state). The PR's own
// header state pill is the first `.State--*` element in document order;
// timeline cross-reference pills to other issues/PRs come later in the DOM.
function readPrStateInPage(): "open" | "closed" | "unknown" {
  const badge = document.querySelector(
    ".State--open, .State--draft, .State--merged, .State--closed",
  );
  if (badge) {
    if (
      badge.classList.contains("State--merged") ||
      badge.classList.contains("State--closed")
    ) {
      return "closed";
    }
    return "open";
  }
  // Hidden header hook used by the classic UI when the visible pill is absent.
  const header = document.querySelector(
    ".js-pull-header-details[data-pull-is-open]",
  );
  if (header) {
    return header.getAttribute("data-pull-is-open") === "true"
      ? "open"
      : "closed";
  }
  return "unknown";
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

function setupAutoDiscard() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    const tabId = tabIdFromDiscardAlarm(alarm.name);
    if (tabId === null) return;
    void maybeDiscardTab(tabId);
  });

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    void handleTabActivated(tabId, windowId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Reset the timer when navigation finishes or audio stops; without this,
    // a tab that just became eligible (audio ended, page finished loading)
    // would keep its old timer (or have none) and miss its discard window.
    if (
      changeInfo.status === "complete" ||
      changeInfo.audible === false ||
      changeInfo.url
    ) {
      armDiscardTimer(tab);
    } else if (changeInfo.discarded === true) {
      clearDiscardTimer(tabId);
    }
  });

  chrome.tabs.onCreated.addListener((tab) => armDiscardTimer(tab));

  chrome.tabs.onRemoved.addListener((tabId) => {
    clearDiscardTimer(tabId);
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    void chrome.storage.session.remove(activeTabSessionKey(windowId));
  });

  chrome.runtime.onStartup.addListener(() => {
    void chrome.storage.session.clear().then(() => armMissingInactiveTabs());
  });
  chrome.runtime.onInstalled.addListener(() => void armMissingInactiveTabs());

  // First boot of this SW instance — alarms persist across SW sleep, but if
  // the extension was just installed/updated, prime everything.
  void armMissingInactiveTabs();
}

async function handleTabActivated(tabId: number, windowId: number) {
  clearDiscardTimer(tabId);

  const key = activeTabSessionKey(windowId);
  const stored = await chrome.storage.session.get(key);
  const previousTabId = stored[key];

  await chrome.storage.session.set({ [key]: tabId });

  if (typeof previousTabId === "number" && previousTabId !== tabId) {
    try {
      const previousTab = await chrome.tabs.get(previousTabId);
      armDiscardTimer(previousTab);
    } catch {
      // tab gone — ignore
    }
  }
}

function discardAlarmName(tabId: number): string {
  return `${DISCARD_ALARM_PREFIX}${tabId}`;
}

function tabIdFromDiscardAlarm(name: string): number | null {
  if (!name.startsWith(DISCARD_ALARM_PREFIX)) return null;
  const id = parseInt(name.slice(DISCARD_ALARM_PREFIX.length), 10);
  return Number.isFinite(id) ? id : null;
}

function activeTabSessionKey(windowId: number): string {
  return `${ACTIVE_TAB_SESSION_PREFIX}${windowId}`;
}

function isSpecialDiscardURL(url: string | undefined): boolean {
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

function isHostDenylisted(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return DISCARD_HOST_PREFIX_DENYLIST.some((prefix) => host.startsWith(prefix));
}

// chrome.alarms minimum delay is 30s. A tab idle longer than the discard
// window should fire (close to) immediately on the next SW pass.
const ALARM_MIN_DELAY_MS = 30 * 1000;

function armDiscardTimer(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return;
  if (tab.discarded) return;
  if (tab.active) return;
  if (isSpecialDiscardURL(tab.url)) return;
  // Pinned/audible/whitelist are checked again at fire time. We could skip
  // the alarm here too, but leaving it scheduled keeps the logic simple if
  // the tab later becomes unpinned, etc. — re-checked before discard.
  const lastAccess = tab.lastAccessed ?? Date.now();
  const idleMs = Math.max(0, Date.now() - lastAccess);
  const remainingMs = Math.max(
    DISCARD_AFTER_MINUTES * 60 * 1000 - idleMs,
    ALARM_MIN_DELAY_MS,
  );
  chrome.alarms.create(discardAlarmName(tab.id), {
    when: Date.now() + remainingMs,
  });
}

function clearDiscardTimer(tabId: number) {
  void chrome.alarms.clear(discardAlarmName(tabId));
}

// SW boot path: never overwrite an existing alarm — MV3 service workers
// restart constantly, and re-arming on every boot would push every timer back
// to "now + 60min" forever, so nothing ever discards.
async function armMissingInactiveTabs() {
  const [tabs, alarms] = await Promise.all([
    chrome.tabs.query({}),
    chrome.alarms.getAll(),
  ]);
  const liveTabIds = new Set(
    tabs
      .map((t) => t.id)
      .filter((id): id is number => id !== undefined),
  );
  const armedTabIds = new Set<number>();
  for (const alarm of alarms) {
    const tabId = tabIdFromDiscardAlarm(alarm.name);
    if (tabId === null) continue;
    if (liveTabIds.has(tabId)) {
      armedTabIds.add(tabId);
    } else {
      // Stale alarm (browser restart re-numbers tab IDs, or removal listener
      // missed). Drop it.
      void chrome.alarms.clear(alarm.name);
    }
  }
  for (const tab of tabs) {
    if (tab.id !== undefined && armedTabIds.has(tab.id)) continue;
    armDiscardTimer(tab);
  }
}

async function isFormDirty(tabId: number): Promise<boolean> {
  // Content script lives in the page, so this round-trip survives SW sleep.
  // No listener (chrome://, file://, content script not yet injected) → treat
  // as not dirty so we don't refuse to discard pages that can never have
  // form input in the first place.
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: "is-form-dirty",
    })) as { dirty?: boolean } | undefined;
    return response?.dirty === true;
  } catch {
    return false;
  }
}

async function isDiscardEligible(tab: chrome.tabs.Tab): Promise<boolean> {
  if (tab.id === undefined) return false;
  if (tab.discarded) return false;
  if (tab.active) return false;
  if (isSpecialDiscardURL(tab.url)) return false;
  if (DISCARD_IGNORE_PINNED && tab.pinned) return false;
  if (DISCARD_IGNORE_AUDIBLE && tab.audible) return false;
  if (isHostDenylisted(tab.url)) return false;
  if (DISCARD_PAUSE_WHEN_OFFLINE && !navigator.onLine) return false;
  if (await isFormDirty(tab.id)) return false;
  return true;
}

async function maybeDiscardTab(tabId: number) {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // tab gone
  }
  if (!(await isDiscardEligible(tab))) return;
  try {
    await chrome.tabs.discard(tabId);
  } catch {
    // tab activated/removed between check and call — ignore
  }
}
