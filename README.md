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

Tabs are also auto-discarded after 60 minutes of inactivity using Chrome's native `chrome.tabs.discard`. Pinned tabs, tabs playing audio, and any host starting with `archive.` (archive.org, archive.today, archive.ph, etc.) are exempted, as are tabs with unsaved form input. Discarding pauses while offline so reloads don't fail.

The toolbar icon opens a popup listing every action plus live counts for duplicates and windows. A badge on the icon shows the duplicate count across all windows (debounced, only recomputed on URL changes).

## Options

Everything is a hardcoded constant at the top of `entrypoints/background.ts` except the GitHub owners the stale-tab sweep applies to, which are per-user. Set those on the options page ("Options" in the popup, or right-click the toolbar icon → Options): one user or organization per line, stored in `chrome.storage.sync`. Until at least one owner is listed, "Close stale GitHub tabs" opens the options page.

## Development

```sh
pnpm install
pnpm dev        # launch Chrome with extension loaded
pnpm build      # production build → .output/chrome-mv3/
pnpm zip        # zip for Chrome Web Store
```

## Install from source

1. `pnpm build`
2. Open `chrome://extensions`, enable Developer mode
3. "Load unpacked" → select `.output/chrome-mv3/`
