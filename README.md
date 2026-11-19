# Tab Tools

Chrome extension (MV3, built with [WXT](https://wxt.dev/)) with keyboard shortcuts for copying/pasting tab URLs, grouping tabs by domain, closing duplicate tabs, merging and splitting windows, sorting tabs, closing stale GitHub tabs, and triaging every open tab one at a time. Clicking the toolbar icon opens a menu of the same actions.

## Shortcuts

- **Cmd+Shift+C** — Copy tab URLs to clipboard (one per line). If >1 tab is selected, copies only selected tabs; otherwise copies all tabs in the window.
- **Cmd+Shift+V** — Open all `http://` / `https://` URLs from clipboard as new tabs.

Chrome caps extensions at 4 `suggested_key` bindings per manifest, so the remaining three actions live only in the toolbar popup by default. Bind them manually at `chrome://extensions/shortcuts` if you want keyboard access:

- **Group tabs by domain** — Groups all tabs in the current window by domain (batched, works fast on 600+ tabs). Also auto-groups new tabs as they load once ≥4 share a domain. A domain's group is the same color in every window.
- **Close duplicate tabs** — Closes duplicates across all windows. Matches by URL (hostname lowercased, trailing slash ignored). Skips pinned tabs; keeps the active tab or the most-recently-accessed duplicate.
- **Merge all windows** — Merges all normal windows into the current window. Preserves pinned tabs and keeps one tab group per title: groups that share a title across windows become a single group.
- **New window with current + tabs to right** — Splits the active tab and every tab to its right off into a fresh window. Preserves pinned state and re-creates tab groups with cloned title/color.
- **New window with tabs to right** — Same as above but leaves the active tab behind.
- **Sort tabs by URL / by title** — Reorders tabs in the current window. Groups are alphabetized A→Z; within each group, tabs are sorted by SLD+subdomain+path (URL mode) or title (title mode). Pinned tabs are untouched, ungrouped tabs go at the end.
- **Show vertical tabs** — Opens a side panel listing every tab in the current window in real tab-strip order, with group headers and colors preserved. Click a row to activate, × (or middle-click) to close, click a group header to collapse/expand (syncs back to Chrome's tab strip).
- **Close stale GitHub tabs** — Closes, for each GitHub owner listed on the options page: every `/pulls` list page and `/actions/runs/<id>` workflow-run page, plus any `/pull/<n>` tab whose PR is merged or closed. PR state is read directly from each tab's DOM (no API calls), so it's fast even with many tabs. Discarded PR tabs are reloaded first so they have a DOM to read — safe, because a discarded tab is already unloaded and has no draft to lose; loaded tabs are read in place and never reloaded.
- **Triage tabs one at a time** — Opens a full-page view that deals every open tab as a card with a live preview and one-key ways to dispose of it. See below.

Tabs are also auto-discarded after 60 minutes of inactivity using Chrome's native `chrome.tabs.discard`. Pinned tabs, tabs playing audio, and any host starting with `archive.` (archive.org, archive.today, archive.ph, etc.) are exempted, as are tabs with unsaved form input. Discarding pauses while offline so reloads don't fail. A single repeating alarm sweeps all tabs once a minute, so it works at any tab count (Chrome caps an extension at 500 active alarms).

## Tab triage

A separate page ("Triage tabs one at a time" in the popup, or the `triage-tabs` command) that deals every open tab as a card and gives you five ways to get rid of it.

Opening the page prepares the tabs and goes straight to work: the post list if any x.com posts are open, otherwise the first card. Each card shows a **live view of the page itself** in a frame, the page's own prose fetched directly, its title and description, and one line saying how you have treated it ("opened 44d ago, never came back" / "came back on 6 days, last 3d ago") — usually the whole decision. Where it was recorded, the card also says what the tab was opened from: the search that led to it, or the title and site of the page it was opened on.

- **r** — save to Readwise Reader and close
- **t** — add to Todoist and close
- **c** — close
- **g** — go to the tab, leaving it open, and move on
- **space** — skip, and it will not come back this session
- **e** — show or hide the page text
- **p** — switch between the cards and the post list
- **u** undo, **esc** done

x.com posts are not dealt as cards. The page opens on the **post list**: every open post at once in a grid, each shown as Twitter's own embed, so it looks as it does on x.com with its media and quoted post. The same keys act on the highlighted row, and **j** / **k** or the arrow keys move it. Deciding the last post moves on to the cards for everything else, and the tally carries over between the two.

Cards arrive grouped by **space**: a site plus its first path segment, so `x.com/simonw` or `github.com/canvas-medical`. The biggest space comes first and arrives whole, longest-untouched first within it, so related tabs land consecutively and the thinking done on one carries into the next. Segments that name a kind of page rather than a place — `status`, `blog`, a date, a numeric id, a long slug — fall back to the bare site. 77 undifferentiated x.com tabs become a list of accounts you can decide about one at a time.

Which card is showing is kept in the page's URL, so reloading the page — or coming back after a crash — resumes exactly where you were.

- Most sites refuse to be framed. The preview strips those headers for this one tab while the queue is open, and nowhere else in the browser. When a page is refused anyway the card says which site refused and shows the page's own picture instead — `og:image` for most sites, and for an x.com post the photo itself.
- YouTube plays in the card: its watch page frames fine, while its embedded player refuses any embedder that is not an ordinary web page.
- x.com posts are read from Twitter's syndication endpoint rather than by loading the page, which serves no per-post metadata at all and never renders in a background tab. One JSON request per post, no page load.
- Page metadata is captured just before a tab is auto-discarded, and pulled from every loaded tab when the triage page opens. Nothing is ever reloaded to read it — the card fetches the page's text at the moment you need it.
- A save or task that fails leaves the tab open and says why, rather than closing it and losing it. Undo reopens the last closed tab; anything already sent stays sent.
- Pinned, blank, and new-tab pages are excluded. Nothing is written to a real tab until you press a key.

Saving needs tokens on the options page: a [Readwise access token](https://readwise.io/access_token) and a Todoist API token (Settings → Integrations → Developer). Both are stored locally and never synced.

The toolbar icon opens a popup listing every action plus live counts for duplicates and windows. A badge on the icon shows the duplicate count across all windows (debounced, only recomputed on URL changes).

## What you actually go back to

Order splits first on engagement. Tabs you have come back to on **separate days** go last in the queue: on a real 754-tab set that was mail, calendar, LinkedIn, Drive, a trip being planned and a post being reread — 98 of 754. They are the likeliest keeps, and by the time they arrive the pile in front of them is gone.

Days rather than visits, because a mass reload — a crash, a restore — is one day however many tabs it touches, while by visit count 96% of that same set looked like something you keep going back to.

## Options

Everything is a hardcoded constant at the top of `entrypoints/background.ts` except the GitHub owners the stale-tab sweep applies to, which are per-user. Set those on the options page ("Options" in the popup, or right-click the toolbar icon → Options): one user or organization per line, stored in `chrome.storage.sync`. Until at least one owner is listed, "Close stale GitHub tabs" opens the options page.

## Development

```sh
pnpm install
pnpm dev        # launch Chrome with extension loaded
pnpm build      # production build → .output/chrome-mv3/
pnpm zip        # zip for Chrome Web Store
pnpm test       # vitest unit tests for the ordering/discard/preview logic
pnpm typecheck
```

After a build, `node scripts/verify-triage.mjs` runs the triage page end to end: it loads the built extension into a throwaway Chrome profile, opens a set of pages across three spaces, and asserts that the page deals them in space order, that reloading resumes on the same card, that the preview renders despite every fixture sending `X-Frame-Options: DENY`, that a save with no token fails without closing the tab, and that the page opens on the post list, which shows each post's text, closes a post's tab, and survives a reload.

## Install from source

1. `pnpm build`
2. Open `chrome://extensions`, enable Developer mode
3. "Load unpacked" → select `.output/chrome-mv3/`
