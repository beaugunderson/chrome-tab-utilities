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

## Structure

- `wxt.config.ts` — manifest config (permissions, keyboard shortcuts, action popup)
- `entrypoints/background.ts` — command handler, popup message dispatcher, duplicate-tab badge
- `entrypoints/popup/` — toolbar-icon menu (HTML + TS + CSS) that dispatches actions via `chrome.runtime.sendMessage`
- `entrypoints/sidepanel/` — vertical tabs side panel (HTML + TS + CSS), bound to its host window
- `entrypoints/options/` — options page (HTML + TS + CSS); holds the only user-facing setting, the GitHub owner list
- `entrypoints/form-watcher.content.ts` — content script that tracks dirty form input per page, queried by background before discarding
- `entrypoints/offscreen.html` — offscreen document for clipboard API access
- `public/offscreen.js` — offscreen script (in `public/` to avoid WXT naming conflict with the HTML entrypoint)

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

- Per-tab `chrome.alarms` keyed `discard:<tabId>`. Set when a tab loses focus (`tabs.onActivated`, page load completes, audio stops, URL changes); cleared when the tab becomes active or is removed
- Hardcoded settings at top of `background.ts`: `DISCARD_AFTER_MINUTES=60`, ignore pinned + audible, pause when offline, never discard hosts starting with `archive.` (covers archive.org, archive.today, archive.ph, etc.; `web.archive.org` is intentionally still discardable since it just serves snapshots)
- Form-dirty check: alarm handler `chrome.tabs.sendMessage(tabId, {type: 'is-form-dirty'})` to the content script, which holds a local `dirty` flag flipped on the first `input`/`change` event after navigation. Round-trip survives SW sleep because the content script lives in the page; failed message (no listener / chrome:// page) treated as not-dirty
- Per-window previous-active-tab tracked in `chrome.storage.session` (key `activeTab:<windowId>`) so SW sleep doesn't lose the "previously active tab needs a fresh timer" signal
- All eligibility checks (pinned/audible/active/whitelist/offline/dirty) re-evaluated at fire time, not arm time, so a tab unpinned mid-timer can still be discarded

## Stale GitHub tab cleanup

- Triggered from the popup ("Close stale GitHub tabs") or the `close-stale-github-tabs` command. Scoped to the owner list in `chrome.storage.sync` under `githubStaleOrgs`, set on the options page and lowercased at read time since GitHub treats the owner path segment case-insensitively. An empty list opens the options page instead of sweeping
- Closes `/pulls` list pages and `/actions/runs/<id>` workflow-run pages outright; `/pull/<n>` tabs only if the PR is merged or closed
- PR state is read from the tab's DOM, not the API: `chrome.scripting.executeScript` injects `readPrStateInPage`, which reads the first `.State--*` pill in document order (the header badge; timeline cross-reference pills come later) and falls back to the classic-UI `.js-pull-header-details[data-pull-is-open]` hook. "Merged" and "closed" both map to closeable; anything unverifiable returns `unknown` and is left open
- Discarded PR tabs are reloaded first (via `ensureTabLoaded`) so they have a DOM; a discarded tab is already unloaded so reloading loses no draft. Loaded tabs are read in place and never reloaded. Reloads run through `mapWithConcurrency` (limit 8) to avoid a network storm
- Requires the `scripting` permission and `*://github.com/*` host permission
- Reloading a discarded tab can make Chrome replace it with a **new tab id** (`chrome.tabs.onReplaced`). `ensureTabLoaded` tracks the replacement and returns the live id so injection and removal target the right tab, not the dead pre-reload one
- Tabs are closed one-by-one via `removeTabs` (Promise.allSettled), never `chrome.tabs.remove([...ids])` — the array form rejects the *whole* batch if any single id is stale, which would close nothing and throw uncaught

## Notes

- Offscreen document is required because MV3 service workers have no DOM/clipboard access
- MV3 CSP forbids inline scripts in HTML, so `offscreen.js` lives in `public/` and is referenced via `<script src>`
- WXT treats same-named `.html` and `.ts` files in `entrypoints/` as duplicate entrypoints, hence the `public/` placement
- Must use `chrome.offscreen` / `chrome.runtime.getContexts` directly (not WXT's `browser.*` polyfill) since these are Chrome-specific APIs
- Clipboard read uses `document.execCommand("paste")`, not `navigator.clipboard.readText()`, because offscreen documents lack focus
