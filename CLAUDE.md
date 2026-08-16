# Tab Tools

Chrome MV3 extension built with WXT. Keyboard shortcuts for:
- Copy/paste tab URLs via clipboard
- Group tabs in the current window by domain (replaces the "Group Tabs By Domain" extension, which serialized API calls per tab and lagged badly at 600+ tabs)
- Close duplicate tabs across all windows (replaces "Close Duplicate Tabs"; keeps active-or-most-recently-accessed tab, skips pinned, normalizes host case + trailing slash)
- Merge all windows into the current window (replaces "Merge Windows"; properly re-creates cross-window groups via `chrome.tabs.group({createProperties:{windowId}})` with cloned title/color, awaits moves before restoring pinned state)
- Split active tab + tabs to right (or just tabs to right) into a new window (replaces "New Window With Tabs To Right"; sorts by `tab.index` for deterministic ordering, re-creates groups, re-pins)
- Sort tabs in current window by URL or title (replaces "Super Tab Sorter"; groups alphabetized A→Z, `tldts` for SLD extraction, proper `await` throughout where original mixed `await` with callback-form Chrome APIs and raced on running `groupOffset`)
- Vertical tabs via `chrome.sidePanel` — mirrors the current window's tab order and grouping, click row to activate, × / middle-click to close, click group header to toggle collapsed (state syncs back to Chrome's real tab strip)
- Auto-discard inactive tabs via native `chrome.tabs.discard` (replaces "The Great-er Discarder-er"; native discard only, no suspend page, no migration cruft)
- Close stale GitHub tabs for the GitHub owners configured on the options page (replaces the `close-stale-gh-tabs` bash script; reads PR merged/closed state from each tab's DOM via `chrome.scripting.executeScript` instead of per-PR `gh pr view` calls)
- Triage tabs by topic: a full page that clusters every tab semantically with a local embedding model, for bulk closure

## Structure

- `wxt.config.ts` — manifest config (permissions, keyboard shortcuts, action popup, CSP)
- `entrypoints/background.ts` — command handler, popup message dispatcher, duplicate-tab badge, discard sweep, tab-signal capture
- `entrypoints/popup/` — toolbar-icon menu (HTML + TS + CSS) that dispatches actions via `chrome.runtime.sendMessage`
- `entrypoints/sidepanel/` — vertical tabs side panel (HTML + TS + CSS), bound to its host window
- `entrypoints/triage/` — semantic clustering page (HTML + TS + CSS); the only place the embedding model runs
- `entrypoints/options/` — options page (HTML + TS + CSS); holds the only user-facing setting, the GitHub owner list
- `entrypoints/page-signals.content.ts` — content script doing two jobs: dirty-form tracking (queried before discarding) and page-metadata harvesting (cached per URL for clustering)
- `entrypoints/offscreen.html` — offscreen document for clipboard API access
- `public/offscreen.js` — offscreen script (in `public/` to avoid WXT naming conflict with the HTML entrypoint)
- `lib/` — pure modules with vitest coverage: `cluster.ts`, `label.ts`, `features.ts`, `discard.ts`, `store.ts`, `embed.ts`, `tabs.ts`, `url.ts`
- `scripts/copy-ort.mjs` — stages the ONNX runtime into gitignored `public/ort/` before every build
- `scripts/verify-triage.mjs` — end-to-end check of the triage page in a real headless Chrome

## Domain grouping

- SLD extracted via `tldts` (`getDomainWithoutSuffix`); falls back to full host for URLs with no public-suffix match (localhost, chrome://, etc.)
- Hotkey (`Cmd+Shift+K`) does a single-pass sweep: one `chrome.tabs.group` call per domain, group creates/updates fired in parallel via `Promise.all`
- `tabs.onUpdated` listener auto-groups new/changed tabs with a 200ms per-domain debounce to coalesce rapid tab loads
- Settings are hardcoded constants at the top of `background.ts` (MIN_TABS=4, IGNORE_PINNED, AUTO_COLLAPSE, MOVE_TO_END)
- Auto-collapse keeps the active tab's group expanded so it doesn't force a tab switch

## Build

```sh
pnpm dev    # dev mode with hot reload
pnpm build  # production build
```

## Vertical tabs (side panel)

- Entry point: "Show vertical tabs" in the popup → `chrome.sidePanel.open({windowId})`. Called from the popup click handler (user gesture); `chrome.windows.getCurrent()` is invoked via `.then()` rather than `await` so the gesture isn't consumed before the open call
- Side panel is scoped to its host window via `chrome.windows.getCurrent()` at init; all tab/tabGroup events are filtered to that `windowId`
- Full re-query + re-render on any relevant event, coalesced via `requestAnimationFrame` so bursts collapse to one render; scroll position preserved across renders
- Group collapsed state is read from and written to `chrome.tabGroups` so the side panel and Chrome's own tab strip stay in sync
- Group colors mirror Chrome's palette (`GROUP_COLORS` map) rendered as a left border on headers + group rows
- Close button on each row calls `chrome.tabs.remove`; middle-click does the same. Row click calls `chrome.tabs.update({active:true})`

## Auto-discard

- One repeating `chrome.alarms` entry (`discard-sweep`, every minute) sweeps all tabs. Chrome caps an extension at **500 active alarms**, so a per-tab alarm scheme throws `An extension cannot have more than 500 active alarms` past that point and stops discarding entirely — never reintroduce one
- Eligibility lives in `lib/discard.ts` as the pure `selectDiscardCandidates(tabs, policy, {now, online})`, which is unit tested; `background.ts` only supplies the policy and does the async form-dirty check on the survivors
- Hardcoded settings at top of `background.ts`: `DISCARD_AFTER_MINUTES=60`, ignore pinned + audible, pause when offline, never discard hosts starting with `archive.` (covers archive.org, archive.today, archive.ph, etc.; `web.archive.org` is intentionally still discardable since it just serves snapshots)
- Form-dirty check: the sweep sends `chrome.tabs.sendMessage(tabId, {type: 'is-form-dirty'})` to the content script, which holds a local `dirty` flag flipped on the first `input`/`change` event after navigation. Round-trip survives SW sleep because the content script lives in the page; failed message (no listener / chrome:// page) treated as not-dirty. Capped at 12 in flight
- Because the sweep reads live tab state, every check is evaluated at the moment of discarding: a tab unpinned mid-window is immediately eligible with no timer to re-arm

## Stale GitHub tab cleanup

- Triggered from the popup ("Close stale GitHub tabs") or the `close-stale-github-tabs` command. Scoped to the owner list in `chrome.storage.sync` under `githubStaleOrgs`, set on the options page and lowercased at read time since GitHub treats the owner path segment case-insensitively. An empty list opens the options page instead of sweeping
- Closes `/pulls` list pages and `/actions/runs/<id>` workflow-run pages outright; `/pull/<n>` tabs only if the PR is merged or closed
- PR state is read from the tab's DOM, not the API: `chrome.scripting.executeScript` injects `readPrStateInPage`, which reads the first `.State--*` pill in document order (the header badge; timeline cross-reference pills come later) and falls back to the classic-UI `.js-pull-header-details[data-pull-is-open]` hook. "Merged" and "closed" both map to closeable; anything unverifiable returns `unknown` and is left open
- Discarded PR tabs are reloaded first (via `ensureTabLoaded`) so they have a DOM; a discarded tab is already unloaded so reloading loses no draft. Loaded tabs are read in place and never reloaded. Reloads run through `mapWithConcurrency` (limit 8) to avoid a network storm
- Requires the `scripting` permission and `*://github.com/*` host permission
- Reloading a discarded tab can make Chrome replace it with a **new tab id** (`chrome.tabs.onReplaced`). `ensureTabLoaded` tracks the replacement and returns the live id so injection and removal target the right tab, not the dead pre-reload one
- Tabs are closed one-by-one via `removeTabs` (Promise.allSettled), never `chrome.tabs.remove([...ids])` — the array form rejects the *whole* batch if any single id is stale, which would close nothing and throw uncaught

## Tab triage (semantic clustering)

- Pipeline: tab → feature text (`lib/features.ts`) → MiniLM embedding (`lib/embed.ts`) → structurally adjusted cosine distance → average-linkage dendrogram (`lib/cluster.ts`) → cut by the granularity slider → c-TF-IDF labels (`lib/label.ts`)
- **Average linkage, not k-means**: no `k` to choose, singletons are fine, cluster sizes can be wildly uneven, and the merge tree gives sub-clusters for free. NN-chain is exact here because average linkage is reducible for *any* symmetric non-negative input (the Lance-Williams update is a weighted average of the two distances it replaces), which matters since the structural factors deliberately break the triangle inequality
- **No PCA/UMAP/t-SNE.** At a few hundred tabs the full distance matrix is milliseconds, so reduction buys nothing; it would only be needed for a 2D map. Clustering on t-SNE output would be wrong regardless — it distorts density and inter-cluster distance by design
- **Cuts are by inconsistency, not by absolute height.** `inconsistencies()` scores each merge by how far it sits above the merges beneath it, measured in their own standard deviations; `cutTreeInconsistent` keeps a subtree whole only when every merge inside it is consistent. One global height cannot work here: a tight topic and a broad one merge at completely different distances, so any single height shreds one or fuses the other. `lib/cluster.test.ts` proves the premise by checking that no flat cut recovers a three-group fixture that inconsistency does. `cutTree` (flat height) survives for `subCut`, where the scale is already local to one subtree
- `INCONSISTENCY_DEPTH` is 3, not scipy's default of 2. Measured, not assumed: at depth 2 a merge joining an internally loose topic to an unrelated one did not stand out, because its own children were already tall
- The slider maps its position to a *quantile* of the values present, not to a raw range, or most of the travel would do nothing. Cuts are top-down so the result is always a partition
- The opening cut is found, not fixed (`defaultThreshold`): the coarsest threshold at which no cluster holds more than a tenth of the tabs. A constant cannot do it — measured on a real 704-tab set, scipy's usual 1.15 gave 281 clusters with a median size of 2, while the search picks 1.559 for 98 clusters, largest 7%, median 5. Where the usable range sits depends on the tab set
- Structural factors in `distanceMatrix` shrink distance multiplicatively: shared opener root ×0.6, same existing tab group ×0.7, same domain ×0.85. `openerTabId` is the strongest same-task signal available
- Chrome drops `openerTabId` and resets `lastAccessed` on restart, so `setupTabSignals()` in `background.ts` snapshots both per URL into `chrome.storage.local`. There is no way to recover them after the fact
- **The model runs in the triage page**, not the service worker (killed at 30s idle) and not the offscreen document: Chrome permits exactly one offscreen document, and `writeToClipboard`/`readFromClipboard` call `closeDocument()` after every copy, so a `Cmd+Shift+C` would unload the model
- MV3 forbids remote script, so the ONNX runtime is served from the extension (`public/ort/`, staged by `scripts/copy-ort.mjs`) with `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/")` and `env.useWasmCache = false` (the wasm-cache path builds a blob URL, which the extension CSP blocks). Model *weights* are data and still come from the HF CDN once, hence the `huggingface.co` / `*.hf.co` host permissions
- Setting `wasmPaths` makes ORT request the **asyncify** runtime pair, not the plain one — verified by `scripts/verify-triage.mjs`, which asserts every fetched `ort/` file is one `copy-ort.mjs` stages. `lib/embed.test.ts` pins the transformers.js minor so a bump forces that check to be re-run
- **Metadata is captured before discarding, not after.** `checkBeforeDiscard` in background.ts asks for it on the same round trip as the form-dirty check, because a discarded tab has no content script and can only be read again by reloading it. With auto-discard on, nearly every tab in a long-lived set is discarded, so without this coverage sits near zero and clustering runs on titles alone
- The triage page also offers an explicit, opt-in backlog pass (`harvestDiscarded`) that reloads already-discarded tabs, reads them, and discards them again. Never automatic: it is one real page load per tab
- **The page reports its own title, and that is the copy we trust.** `TabRecord.title` holds what the page said; Chrome shows the URL for a tab it never loaded, and a title a JS app sets does not survive the tab being discarded a moment later. On x.com the title *is* the post, so capturing it is the difference between clustering those tabs and not. `isRealTitle` decides whether a title says more than the address, and `isUnidentified`/`featureText` fall back to the stored one
- A harvest that captures only a title counts as a success, not an empty read
- The content script keeps looking for up to 5s when DOMContentLoaded turns up nothing, then reports whatever it has. A JS app has no description, no heading and not even a title at that point: reading once and giving up returned nothing for 84 of 87 x.com tabs. Pages that are ready immediately still report immediately
- Nothing resolves on `status: "complete"` either — a JS app reports complete before it renders, and discarding then captured nothing, not even the title the app sets later. The content script says when it is done; the per-tab timeout covers pages whose script never runs
- That pass resolves on the content script's DOMContentLoaded push, not on `status: "complete"`, and discards the instant it has the metadata — which also cancels the rest of the load. Measured on a page with one slow asset: metadata at 25ms, `complete` never arriving at all within 15s. Waiting on the load event is what made it crawl, since every unsettled page burned the full per-tab timeout
- The triage page backfills page metadata by messaging every loaded tab's content script (`get-page-meta`) before embedding. Without it the harvest only ever fires on a page *load*, so tabs open since before install have none and discarded tabs never will, leaving titles and URL words as the only signal on exactly the large long-lived tab set this is for. The stats line reports the coverage percentage
- Labels use unigrams *and* adjacent word pairs, in the casing they were written in. Three rules keep them readable: a word whose count exactly equals a phrase containing it is dropped (it never occurs outside that phrase); a phrase containing a word present in every cluster is dropped, or a ubiquitous "| GitHub" suffix sneaks back in as a per-cluster bigram; and a label spends at most `LABEL_WORD_BUDGET` words
- Headings shared by three or more pages of one host are dropped as site furniture (`boilerplateHeadings`), no per-site rules needed. On the real set, 73 GitHub tabs had harvested their heading as "Command palette", a hidden dialog title, which polluted both their embeddings and their labels. The content script also now takes the first *visible* h1 rather than the first in DOM order
- The page has a Copy JSON button that dumps clusters with full membership. Judging quality needs membership, not labels: a label can read plausibly over a cluster that makes no sense
- `cleanTitle` strips unread counts and a trailing site name before embedding. Both make unrelated tabs on one host look alike and crowd out the few words that say what the page is
- Embeddings are cached per URL in `chrome.storage.local` as base64 int8 (~384 bytes/tab), keyed by a fingerprint of the feature text so a retitled or retagged tab re-embeds and nothing else does. One batched write per run, never per tab
- Near-duplicates read raw embeddings, deliberately bypassing the structural factors, or same-domain tabs would register as duplicates of each other on shape alone
- **Duplicate detection requires content.** Only tabs with a harvested description or heading are eligible (`hasReadableContent`). Two tabs nobody has read embed almost identically whenever their titles and URL shapes match, so a dozen different tweets by one author all looked like duplicates of each other. Being a duplicate is a claim about content, so it needs content
- **Tabs known only by their address are kept out of the tree** (`isUnidentified`: no description or heading, and a title Chrome filled in with the URL because the tab was never loaded). Their feature text is a host plus a path shape, identical across every item on a site, so they collapse into one lump and act as bridges chaining unrelated clusters together. They render in their own section grouped by host, with its own "Read all" button: that set is not the same as the discarded-tab backlog, because a tab restored from a session but never opened is unloaded without being marked discarded, so `harvestTargets` matches `discarded || status === "unloaded"`. Verified: adding three such tabs to the fixtures dropped the default cut from 4/4 clean topics to 2/4 before this, and back to 4/4 after
- **Closing a tab does not re-cluster.** It marks the leaf in `state.removed` and re-renders; the dendrogram, node ids and slider scale all stay put. Re-running the pipeline on every close rebuilt the tree over a different tab set, which renumbered every node and rebuilt the quantile scale, so the granularity shifted under the user each time they closed something. `chrome.tabs.onRemoved` does the same for tabs closed from the tab strip. Rescan is the deliberate way to get a fresh clustering
- When `run()` does re-cluster, it restores the previous *inconsistency value* rather than the slider position (`parkSliderAt`). Position 400 means something different on every tab set; inconsistency 1.4 does not
- Checkboxes are tri-state and update in place. `render()` rebuilds `rowChecks`/`groupChecks`, and any toggle calls `syncChecks()` rather than re-rendering: a cluster box is checked when all its tabs are selected and indeterminate when only some are, at every nesting level, because a parent's tab list contains all of its descendants'. Re-rendering on each click would rebuild hundreds of rows
- Everything renders expanded. State tracks `collapsed` node ids, not expanded ones, so clusters that only come into existence when the slider moves are open too; "Collapse all" walks the visible tree and adds every node
- A cluster of one renders as a plain `.tab-row`, not a header, so it keeps the close button, tag control and click-to-activate. Anything counting clusters in the DOM has to match `main > .cluster, main > .tab-row`
- `collectMembers` is computed once per render and threaded through `cutTree`/`subCut` via the optional `precomputed` argument. With every cluster expanded there is one `subCut` per visible cluster, and each would otherwise rewalk the whole tree
- Every element that starts with the `hidden` attribute must survive `[hidden] { display: none !important }` in the stylesheet: the granularity bar, backlog prompt and selection footer are all `display: flex`, and a display rule beats the user-agent `[hidden]` rule, so they render permanently without it
- Renders are coalesced to one animation frame (`scheduleRender`). The slider fires `input` per pixel and a pass rebuilds every visible row; anything reading the DOM after a slider change has to wait two frames

## Notes

- Offscreen document is required because MV3 service workers have no DOM/clipboard access
- MV3 CSP forbids inline scripts in HTML, so `offscreen.js` lives in `public/` and is referenced via `<script src>`
- WXT treats same-named `.html` and `.ts` files in `entrypoints/` as duplicate entrypoints, hence the `public/` placement
- Must use `chrome.offscreen` / `chrome.runtime.getContexts` directly (not WXT's `browser.*` polyfill) since these are Chrome-specific APIs
- Clipboard read uses `document.execCommand("paste")`, not `navigator.clipboard.readText()`, because offscreen documents lack focus
