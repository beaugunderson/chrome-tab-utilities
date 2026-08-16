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
import { type PageMeta, featureFingerprint, featureText } from "../../lib/features";
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
/**
 * Where the slider starts, as an inconsistency value rather than a fixed
 * position. 1.15 is scipy's long-standing default for this criterion, and
 * anchoring to the value rather than to a slider position means the opening
 * view is the same kind of cut whether there are 40 tabs or 900.
 */
const DEFAULT_INCONSISTENCY = 1.15;
const TAG_SUGGEST_SIMILARITY = 0.8;
// Quantile of a subtree's own merge heights used when drilling into it.
const SUB_CUT_QUANTILE = 0.6;
// Below this size a cluster shows its tabs directly rather than sub-clusters.
const MIN_SUBCLUSTER_PARENT = 6;
const KEEP_NEWEST_COUNT = 3;
const MAX_GROUP_TITLE = 30;
// Page-metadata requests in flight while backfilling.
const META_CONCURRENCY = 16;

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
  dupeGroups: number[][];
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
  const sources = raw.map((t) => ({
    title: t.title,
    url: t.url,
    meta: records.get(t.url!)?.meta,
    tags: records.get(t.url!)?.tags,
  }));
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
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const record = records.get(urls[i]);
    if (!record?.v) continue;
    // lastAccessed resets on browser restart, so fall back to the snapshot the
    // background keeps per URL, whichever is more recent.
    const lastSeen = Math.max(t.lastAccessed ?? 0, record.seen ?? 0);
    tabs.push({
      id: t.id!,
      windowId: t.windowId!,
      title: t.title || urls[i],
      url: urls[i],
      host: hostOf(urls[i]),
      domain: domainKey(urls[i]),
      favIconUrl: t.favIconUrl,
      discarded: t.discarded ?? false,
      groupId: t.groupId !== undefined && t.groupId >= 0 ? t.groupId : null,
      idleMs: lastSeen > 0 ? now - lastSeen : Number.POSITIVE_INFINITY,
      tags: record.tags ?? [],
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
    selected: new Set(),
    dupeGroups: groupDuplicates(nearDuplicatePairs(inputs, NEAR_DUPLICATE_SIMILARITY)),
    records,
  };

  hideProgress();
  el("granularity").hidden = false;
  resetSliderToDefault();
  render();
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

/** Park the slider at the quantile closest to the default inconsistency. */
function resetSliderToDefault() {
  if (!state || state.scale.length === 0) return;
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < state.scale.length; i++) {
    const gap = Math.abs(state.scale[i] - DEFAULT_INCONSISTENCY);
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

function tabsOf(leaves: number[]): TriageTab[] {
  return leaves.map((i) => state!.tabs[i]);
}

function labelSources(leaves: number[]): LabelSource[] {
  return leaves.map((i) => {
    const tab = state!.tabs[i];
    const record = state!.records.get(tab.url);
    return {
      text: [tab.title, record?.meta?.heading, tab.tags.join(" ")]
        .filter(Boolean)
        .join(" "),
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
      dupes: cluster.leaves.filter((leaf) => context.dupeIndices.has(leaf)).length,
    }))
    .sort((a, b) => closureScore(b.tabs, b.dupes) - closureScore(a.tabs, a.dupes));
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

  el("cut-readout").textContent = `${clusters.length} clusters`;
  const metaShare = Math.round((state.withMeta / state.tabs.length) * 100);
  el("stats").textContent =
    `${state.tabs.length} tabs · ${clusters.length} clusters · ` +
    `${context.dupeIndices.size} near-duplicates · ${metaShare}% with page metadata`;

  const host = el("clusters");
  host.replaceChildren(
    ...ranked.map((entry) =>
      renderCluster(entry.cluster, entry.label, entry.tabs, entry.dupes, 0, context),
    ),
  );

  updateFoldAllLabel();
  renderDuplicates();
  renderSelection();
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
  check.checked = tabs.every((t) => state!.selected.has(t.id));
  check.addEventListener("change", () => {
    for (const tab of tabs) {
      if (check.checked) state!.selected.add(tab.id);
      else state!.selected.delete(tab.id);
    }
    render();
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
  check.checked = state!.selected.has(tab.id);
  check.addEventListener("change", () => {
    if (check.checked) state!.selected.add(tab.id);
    else state!.selected.delete(tab.id);
    renderSelection();
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

async function closeAndRefresh(ids: number[]) {
  if (ids.length === 0) return;
  await removeTabs(ids);
  await run();
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

function renderDuplicates() {
  const host = el("dupes");
  if (!state || state.dupeGroups.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.replaceChildren();

  const heading = document.createElement("h2");
  const total = state.dupeGroups.reduce((sum, g) => sum + g.length - 1, 0);
  heading.textContent = `${total} near-duplicate tabs in ${state.dupeGroups.length} sets`;

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Matched on meaning rather than URL, so the same story on three sites counts.";

  const keepAll = document.createElement("button");
  keepAll.className = "ghost small";
  keepAll.textContent = "Keep newest of each";
  keepAll.addEventListener("click", () => {
    const doomed: number[] = [];
    for (const group of state!.dupeGroups) {
      const sorted = group
        .map((i) => state!.tabs[i])
        .sort((a, b) => a.idleMs - b.idleMs);
      doomed.push(...sorted.slice(1).map((t) => t.id));
    }
    void closeAndRefresh(doomed);
  });

  host.append(heading, note, keepAll);
  for (const group of state.dupeGroups) {
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
