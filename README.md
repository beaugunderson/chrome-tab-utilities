# Tab Tools

Chrome extension (MV3, built with [WXT](https://wxt.dev/)) with keyboard shortcuts for copying/pasting tab URLs, grouping tabs by domain, closing duplicate tabs, and merging windows. Clicking the toolbar icon opens a menu of the same actions.

## Shortcuts

- **Cmd+Shift+C** — Copy tab URLs to clipboard (one per line). If >1 tab is selected, copies only selected tabs; otherwise copies all tabs in the window.
- **Cmd+Shift+V** — Open all `http://` / `https://` URLs from clipboard as new tabs.

Chrome caps extensions at 4 `suggested_key` bindings per manifest, so the remaining three actions live only in the toolbar popup by default. Bind them manually at `chrome://extensions/shortcuts` if you want keyboard access:

- **Group tabs by domain** — Groups all tabs in the current window by domain (batched, works fast on 600+ tabs). Also auto-groups new tabs as they load once ≥4 share a domain.
- **Close duplicate tabs** — Closes duplicates across all windows. Matches by URL (hostname lowercased, trailing slash ignored). Skips pinned tabs; keeps the active tab or the most-recently-accessed duplicate.
- **Merge all windows** — Merges all normal windows into the current window. Preserves pinned tabs and re-creates tab groups in the target window with the original title and color.
- **New window with current + tabs to right** — Splits the active tab and every tab to its right off into a fresh window. Preserves pinned state and re-creates tab groups with cloned title/color.
- **New window with tabs to right** — Same as above but leaves the active tab behind.
- **Sort tabs by URL / by title** — Reorders tabs in the current window. Groups are alphabetized A→Z; within each group, tabs are sorted by SLD+subdomain+path (URL mode) or title (title mode). Pinned tabs are untouched, ungrouped tabs go at the end.
- **Show vertical tabs** — Opens a side panel listing every tab in the current window in real tab-strip order, with group headers and colors preserved. Click a row to activate, × (or middle-click) to close, click a group header to collapse/expand (syncs back to Chrome's tab strip).
- **Close stale GitHub tabs** — Closes, for each GitHub owner listed on the options page: every `/pulls` list page and `/actions/runs/<id>` workflow-run page, plus any `/pull/<n>` tab whose PR is merged or closed. PR state is read directly from each tab's DOM (no API calls), so it's fast even with many tabs. Discarded PR tabs are reloaded first so they have a DOM to read — safe, because a discarded tab is already unloaded and has no draft to lose; loaded tabs are read in place and never reloaded.
- **Triage tabs by topic** — Opens a full-page view that clusters every tab by meaning rather than by domain, ordered by how much closing each cluster would help. See below.

Tabs are also auto-discarded after 60 minutes of inactivity using Chrome's native `chrome.tabs.discard`. Pinned tabs, tabs playing audio, and any host starting with `archive.` (archive.org, archive.today, archive.ph, etc.) are exempted, as are tabs with unsaved form input. Discarding pauses while offline so reloads don't fail. A single repeating alarm sweeps all tabs once a minute, so it works at any tab count (Chrome caps an extension at 500 active alarms).

## Tab triage

A separate page ("Triage tabs by topic" in the popup, or the `triage-tabs` command) that groups tabs by what they are *about*, for deciding what to close.

Each tab is embedded once with a local [MiniLM](https://huggingface.co/Xenova/all-MiniLM-L6-v2) model via [transformers.js](https://huggingface.co/docs/transformers.js), using its title, harvested page metadata, URL path words, and any tags. Those embeddings feed an average-linkage agglomerative clustering pass, which produces a dendrogram — a merge tree — rather than a fixed set of groups.

The **granularity slider** slices that tree. Drag toward "tight" for many small, specific clusters; toward "broad" for a few large ones. Nothing re-clusters while you drag. A cluster shows its own sub-clusters, so a broad "news" cluster opens into per-story groups.

The slice is by *inconsistency* rather than by a fixed distance: a merge counts as a real boundary when it stands well above the merges beneath it, whatever its absolute size. This matters because a tight topic and a sprawling one join up at completely different distances, so any single distance threshold either shreds the sprawling topic or fuses the tight ones into it.

Everything starts expanded, including sub-clusters and clusters that only appear as you move the slider. "Collapse all" folds the lot; individual collapses stick.

- Clusters are ordered by `size × median idle time × duplicate density`, so the biggest, stalest, most redundant pile is first.
- Cluster names come from c-TF-IDF over the member titles: words and short phrases frequent inside the cluster and rare across the others, in their original casing. No model call, so names update instantly with the slider.
- Page metadata is captured just before a tab is auto-discarded, and pulled from every loaded tab when the triage page opens. The stats line shows what share of tabs have it. If tabs were already discarded before this shipped, the page offers a one-off pass that loads each of them once, reads it, and discards it again — stated up front with the count, never automatic.
- **Near-duplicates** are found by cosine similarity rather than URL, which catches the same story on three different sites — something the URL-based duplicate closer structurally cannot.
- Per-cluster actions: close all, keep the 3 most recent, apply as a Chrome tab group, move to a new window, tag all.
- **Tags** are freeform. Tagging a few tabs builds a centroid for that tag, and other tabs near it show the tag ghosted for one-click acceptance. Tags feed back into the embedding, so re-running pulls clusters toward your own taxonomy.
- Pinned, blank, and new-tab pages are excluded. Nothing is written to a real tab until you press an action.

Everything runs locally. The model weights (~25MB) download from the Hugging Face CDN on first run and are cached by the browser; no tab data leaves the machine. Embeddings are cached per URL as int8 vectors and only recomputed when a tab's title, metadata, or tags change.

The toolbar icon opens a popup listing every action plus live counts for duplicates and windows. A badge on the icon shows the duplicate count across all windows (debounced, only recomputed on URL changes).

## Options

Everything is a hardcoded constant at the top of `entrypoints/background.ts` except the GitHub owners the stale-tab sweep applies to, which are per-user. Set those on the options page ("Options" in the popup, or right-click the toolbar icon → Options): one user or organization per line, stored in `chrome.storage.sync`. Until at least one owner is listed, "Close stale GitHub tabs" opens the options page.

## Development

```sh
pnpm install
pnpm dev        # launch Chrome with extension loaded
pnpm build      # production build → .output/chrome-mv3/
pnpm zip        # zip for Chrome Web Store
pnpm test       # vitest unit tests for the clustering/labeling/discard logic
pnpm typecheck
```

`pnpm build` first runs `scripts/copy-ort.mjs`, which stages the ONNX runtime into `public/ort/` (gitignored). MV3 forbids loading remote script, so the runtime has to be served by the extension itself.

After a build, `node scripts/verify-triage.mjs` runs the triage page end to end: it loads the built extension into a throwaway Chrome profile, opens a set of pages across known topics, and asserts they cluster, that the slider changes granularity monotonically, that near-duplicates are detected, and that every ONNX runtime file the page requests is one `copy-ort.mjs` stages.

## Install from source

1. `pnpm build`
2. Open `chrome://extensions`, enable Developer mode
3. "Load unpacked" → select `.output/chrome-mv3/`
