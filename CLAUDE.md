# Tab Tools

Chrome MV3 extension built with WXT. Keyboard shortcuts for:
- Copy/paste tab URLs via clipboard
- Group tabs in the current window by domain (replaces the "Group Tabs By Domain" extension, which serialized API calls per tab and lagged badly at 600+ tabs)
- Close duplicate tabs across all windows (replaces "Close Duplicate Tabs"; keeps active-or-most-recently-accessed tab, skips pinned, normalizes host case + trailing slash)
- Merge all windows into the current window (replaces "Merge Windows"; one group per title in the merged window via `planGroupMerge`, awaits moves before restoring pinned state)
- Split active tab + tabs to right (or just tabs to right) into a new window (replaces "New Window With Tabs To Right"; sorts by `tab.index` for deterministic ordering, re-creates groups, re-pins)
- Sort tabs in current window by URL or title (replaces "Super Tab Sorter"; groups alphabetized A→Z, `tldts` for SLD extraction, proper `await` throughout where original mixed `await` with callback-form Chrome APIs and raced on running `groupOffset`)
- Vertical tabs via `chrome.sidePanel` — mirrors the current window's tab order and grouping, click row to activate, × / middle-click to close, click group header to toggle collapsed (state syncs back to Chrome's real tab strip)
- Auto-discard inactive tabs via native `chrome.tabs.discard` (replaces "The Great-er Discarder-er"; native discard only, no suspend page, no migration cruft)
- Close stale GitHub tabs for the GitHub owners configured on the options page (replaces the `close-stale-gh-tabs` bash script; reads PR merged/closed state from each tab's DOM via `chrome.scripting.executeScript` instead of per-PR `gh pr view` calls)
- Triage tabs one at a time: a full page that deals every open tab as a card with a live preview, four keys to dispose of it, and its place kept in the URL

## Structure

- `wxt.config.ts` — manifest config (permissions, keyboard shortcuts, action popup, CSP)
- `entrypoints/background.ts` — command handler, popup message dispatcher, duplicate-tab badge, discard sweep, tab-signal capture
- `entrypoints/popup/` — toolbar-icon menu (HTML + TS + CSS) that dispatches actions via `chrome.runtime.sendMessage`
- `entrypoints/sidepanel/` — vertical tabs side panel (HTML + TS + CSS), bound to its host window
- `entrypoints/triage/` — the triage page (HTML + TS + CSS): prepares the tabs, then hands them to the card queue in `queue.ts`
- `entrypoints/options/` — options page (HTML + TS + CSS); holds the only user-facing setting, the GitHub owner list
- `entrypoints/page-signals.content.ts` — content script doing two jobs: dirty-form tracking (queried before discarding) and page-metadata harvesting (cached per URL)
- `entrypoints/offscreen.html` — offscreen document for clipboard API access
- `public/offscreen.js` — offscreen script (in `public/` to avoid WXT naming conflict with the HTML entrypoint)
- `lib/` — pure modules with vitest coverage: `order.ts`, `features.ts`, `discard.ts`, `store.ts`, `engagement.ts`, `preview.ts`, `readable.ts`, `tweets.ts`, `tabs.ts`, `url.ts`
- `scripts/verify-triage.mjs` — end-to-end check of the triage page in a real headless Chrome

## Domain grouping

- SLD extracted via `tldts` (`getDomainWithoutSuffix`); falls back to full host for URLs with no public-suffix match (localhost, chrome://, etc.)
- Hotkey (`Cmd+Shift+K`) does a single-pass sweep: one `chrome.tabs.group` call per domain, group creates/updates fired in parallel via `Promise.all`
- `tabs.onUpdated` listener auto-groups new/changed tabs with a 200ms per-domain debounce to coalesce rapid tab loads
- Settings are hardcoded constants at the top of `background.ts` (MIN_TABS=4, IGNORE_PINNED, AUTO_COLLAPSE, MOVE_TO_END)
- Auto-collapse keeps the active tab's group expanded so it doesn't force a tab switch
- Every domain group gets the color `colorForDomain` (`lib/groups.ts`) hashes from its name, so GITHUB is the same color in every window; the hotkey sweep also recolors a domain group that has a different one
- **`chrome.tabs.group` without `groupId` or `createProperties.windowId` creates the group in the focused window and moves the tabs there.** Any call on behalf of a specific window must name it, or tabs loading in a background window are pulled into the one in front
- Merging windows folds groups by title (`planGroupMerge`): tabs join the target window's group of that title, same-titled source groups share one new group, and untitled groups stay separate
- **Chrome saves every tab group, and a saved group outlives its tabs**: closing a window or choosing "Close group" keeps it, and it stays in Chrome's "Add tab to group" menu. `chrome.tabGroups` only sees groups in open windows, so the extension cannot list or delete saved ones. They live in `<profile>/Sync Data/LevelDB` under `saved_tab_group-dt-<guid>` keys, one record per group and one per saved tab

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
- PR state is read from the tab's DOM, not the API: `chrome.scripting.executeScript` injects `readPrStateInPage` (`lib/github.ts`, self-contained because it runs in the page), which reads the header's hidden `.js-pull-header-details[data-pull-is-open]` hook and falls back to the header StateLabel's `data-status` (`pullOpened`, `draft`, `pullMerged`, `pullClosed`). "Merged" and "closed" both map to closeable; anything unverifiable returns `unknown` and is left open
    - **Never read `.State--*` pills.** They belong to timeline cross-references to other issues and PRs: a merged PR referenced by an open one carries `.State--open` and was left open, and an open PR referenced by a merged one would have been closed
- Discarded PR tabs are reloaded first (via `ensureTabLoaded`) so they have a DOM; a discarded tab is already unloaded so reloading loses no draft. Loaded tabs are read in place and never reloaded. Reloads run through `mapWithConcurrency` (limit 8) to avoid a network storm
- Requires the `scripting` permission and `*://github.com/*` host permission
- Reloading a discarded tab can make Chrome replace it with a **new tab id** (`chrome.tabs.onReplaced`). `ensureTabLoaded` tracks the replacement and returns the live id so injection and removal target the right tab, not the dead pre-reload one
- Tabs are closed one-by-one via `removeTabs` (Promise.allSettled), never `chrome.tabs.remove([...ids])` — the array form rejects the *whole* batch if any single id is stale, which would close nothing and throw uncaught

## Tab triage

The triage page **is** the queue: opening it prepares every unpinned tab and deals the first card, with no screen in between.

- **Ordering is by space, not by topic** (`lib/order.ts`). A space is a site plus its first path segment — `x.com/simonw`, `github.com/canvas-medical` — skipping segments that name a kind of page (`status`, `blog`, a date, a numeric id, a long slug). Biggest space first and whole, longest-untouched first within it, and the tabs you come back to last
- **Do not add topic clustering.** It was built, measured and removed: on a real 642-tab set the clusters came out 92% single-kind and 450 tabs were simply "a page on the internet", so a cluster was rarely something one decision could be made about. The only part earning its keep was adjacency, which a space key gives for nothing — and it works on a tab nobody has ever read, needs no model download before the first card, and keeps the build at 378 KB rather than 48 MB
- **Which card is showing lives in the URL** (`?tab=<tabId>`, written with `replaceState` as each card comes up and cleared when the run ends), so reloading resumes in place. A tab already dealt with is gone from the list and its old position means nothing in an order that has since changed, so a missing id starts over. `openTriagePage` must query `triage.html*` with the wildcard, or an open triage tab that has dealt one card is not found and a second one opens beside it
- **The page reports its own title, and that is the copy we trust.** `TabRecord.title` holds what the page said; Chrome shows the URL for a tab it never loaded, and a title a JS app sets does not survive the tab being discarded a moment later. `isRealTitle` decides whether a title says more than the address, and is deliberately strict and case-insensitive: x.com serves a title of "X" until its app renders, and a lenient check counted that as real, so a page was reported read before its content appeared. The content script shares the same function, so it can never decide it is finished on a title the store will then reject
- **x.com posts are read from Twitter's syndication endpoint, not from the page** (`lib/tweets.ts`). Measured on 53 real tabs: x.com serves viewport, fb:app_id, og:site_name and three site-verification tokens, and nothing else — no title, no description, nothing per-post — and the app never hydrates in a background tab, so `document.title` stays empty at `readyState: "complete"`. `cdn.syndication.twimg.com/tweet-result?id=<id>&token=a` returns the post text and its photo as JSON unauthenticated, one small request per post
- **Metadata is captured before discarding, not after.** `checkBeforeDiscard` in background.ts asks for it on the same round trip as the form-dirty check, because a discarded tab has no content script and can only be read again by reloading it. With auto-discard on, nearly every tab in a long-lived set is discarded
- The page backfills metadata by messaging every loaded tab's content script (`get-page-meta`). The content script only reports on a page *load*, so a tab open since before the extension was installed has none. Discarded tabs are skipped rather than reloaded: **nothing reloads a tab to read it**, because the card fetches the page's text itself at decision time, and a bulk reload pass wrote one history visit per tab, which the engagement split then read back as evidence of engagement
- **Harvest og:title and the twitter: card tags, not just og:description.** They are server-rendered, so they survive an app that never hydrates. Measured on 78 real x.com tabs: og:site_name came back while document.title stayed empty for the full settle window, which proved the og tags were in the served HTML and only the uninformative one was being read
- **`hasMetaContent` is the single definition of "this page said something"**, and it counts only a description, a heading or an og:title. A site name, og:type and section belong to the site, not the page. It was briefly two definitions, one counting the site name and one not, and x.com — which serves og:site_name and nothing else — fell into the gap: 78 tabs reported as read, metadata stored, and still treated as unread. Every filter uses this one function
- The content script keeps looking for up to 5s when DOMContentLoaded turns up nothing, then reports whatever it has. A JS app has no description, no heading and not even a title at that point: reading once and giving up returned nothing for 84 of 87 x.com tabs. Pages that are ready immediately still report immediately
- The content script takes the first *visible* h1, not the first in DOM order: 73 GitHub tabs had harvested "Command palette", a hidden dialog title
- Every build stamps `__BUILD_ID__` (wxt.config.ts `define`), and each harvested record carries the build of the content script that answered. **Content scripts do not update in already-open tabs until those tabs navigate**, so a stale one can answer a fresh page and the result is indistinguishable from a broken feature. Compare it against the running build before diagnosing anything

## Engagement, not topic

- **The primary split is whether you came back to a tab on a separate day**, from `chrome.history.getVisits` (`lib/engagement.ts`, needs the `history` permission). Measured on a real 754-tab set: 726 (96%) had two or more visits, so a visit count says nothing, while 111 (15%) were visited on four or more days and that list is the working set exactly — mail, calendar, LinkedIn, Drive, a trip being planned, a post being reread
- **Count days, not visits, because a mass reload is one day however many tabs it touches.** One night of them gave a single x.com post 18 visits across 17 minutes, each in a minute where 56–90 other tabs also loaded. Chrome does not mark those: session restore and our own reloads both record a plain `link` transition, so filtering on `transition` finds nothing
- **Discount the triage page's own sweeps** (`fetchSweepTimes`). Reading a tab's text loads it and a load is a visit, so a harvest writes one visit per tab and the page then reads that back as "you keep going back to all 700 of these" — a closed loop. The triage page's own visits are in history, so its sessions are found via `getVisits` on its own URL and tab loads within 20 minutes of one are dropped, except a tab's first visit. Combined with the three-day threshold this puts 98 of 754 tabs (13%) in the working set, and takes x.com posts from 73 to 1
- Those tabs come last in the queue rather than being mixed through the pile: they are the likeliest keeps, and by the time they arrive whatever was in front of them is gone
- `getVisits` is an exact-URL lookup; `history.search` does substring matching and would credit one tab with another visits

## One-at-a-time queue

- **The card shows a live iframe of the page.** Title and description are frequently useless for deciding — an essay on self-respect whose only description is the author name — and the decision is usually obvious the moment the page is visible
- Most sites refuse framing, so `lib/framing.ts` adds a declarativeNetRequest **session** rule stripping `x-frame-options` and `content-security-policy`, scoped by `tabIds` to the triage tab and by `resourceTypes` to `sub_frame`. The rest of the browser keeps its clickjacking protection, and the rule dies with the browser regardless. Removed when the queue closes
- The card also shows the page prose fetched directly (`lib/readable.ts`), independent of framing, because a live preview fails on any site that refuses to be framed and the decision should not depend on which. Fetched with `credentials: "omit"` — a preview has no business acting as the signed-in user
- **A refused frame is undetectable from inside the page**: it fires the iframe's `load` event exactly like a working one and is cross-origin either way, so `chrome.webNavigation.onErrorOccurred` (`watchBlockedFrames`) is the only signal, reporting `net::ERR_BLOCKED_BY_RESPONSE` where an allowed page reports `onCompleted`. Without it a site the rule failed to unblock is indistinguishable from one still loading, and the card is a grey box
- When a frame is refused the card falls back to the page's own picture — `og:image` for most sites, the syndication endpoint's photo for an x.com post — names the site that refused, and opens the fetched prose. The still is `harvestedStill`, read from the record, because the picture is harvested per page and cannot be derived from a URL the way YouTube's can
- After installing the framing rule the code **reads it back** with `getSessionRules`. The call resolving does not prove a rule exists, and a silently absent rule looks exactly like a site refusing to be framed; when it is missing the queue says so instead of showing dead boxes
- Requires `<all_urls>` host permission and `declarativeNetRequestWithHostAccess`. No broader than the content script already running on `<all_urls>`
- Testing the preview needs Playwright frame API, not `contentDocument`: the frame is cross-origin, so `contentDocument` is null whether or not the page loaded, and a test reading it always fails. The fixtures deliberately send `X-Frame-Options: DENY`, so the check only passes if the stripping works

- `entrypoints/triage/queue.ts`: one tab at a time — r Readwise, t Todoist, c close, space skip, g go to tab, e show text, u undo, esc done. Decisions are per tab, but the order groups a space together, so related tabs arrive consecutively and the thinking done on the last carries into the next
- Per tab rather than per group because a group is rarely one decision: on a real 642-tab set, 60 mid-sized groups of 4-9 tabs held 54% of everything, and a verdict on such a group is often the wrong verdict on its members
- Keys: `r` Readwise, `t` Todoist, `c` close, `space` skip, `g` go to tab, `e` show/hide the fetched text, `u` undo, `esc` done. `e` deliberately has no prior meaning — every other letter either sends or closes, so a slip on the toggle must not be destructive
- `lib/preview.ts` supplies a stand-in for the two sites the framing rule alone does not cover. Vimeo gets `player.vimeo.com/video/<id>`, which frames from anywhere and is cleaner than the page around it. YouTube gets a still (`i.ytimg.com/vi/<id>/maxresdefault.jpg`, falling back on error to `hqdefault.jpg`, which every video has) **only when headers are not being stripped**, because with the rule in force the watch page frames and plays
- **Frame YouTube's watch page, never `/embed/<id>`.** The embedded player refuses any embedder whose origin is not http(s), so it answers `Error 153` on a `chrome-extension://` page: measured across `youtube.com` and `youtube-nocookie.com`, with and without `sandbox`, `referrerpolicy` and `origin=`, on two videos, all eight combinations fail, while the same embed from `http://localhost` does not. The watch page has no such check and plays with `x-frame-options` stripped, which is why the framing rule is the better route and the rewrite to `/embed` was the thing breaking it
- Framing needs granted host access, not just the declared permission: Chrome lets site access be narrowed to "on click" per site, and `declarativeNetRequestWithHostAccess` then strips nothing, which looks exactly like the site refusing. `startQueue` checks `chrome.permissions.contains` before installing the rule so the message names the real cause
- `g` goes to the tab and advances. Some things cannot be judged from a preview, and going there counts as dealing with it: the tab is left open and whatever happens next happens there
- **A failed send never closes the tab.** `applyDisposition` returns an error string, the queue shows it and stays on the item. Closing after a failed save would destroy the thing the save was for
- Readwise is `POST https://readwise.io/api/v3/save/` with `Authorization: Token` (50/min). Todoist is `POST https://api.todoist.com/api/v1/tasks` with `Authorization: Bearer` — **not** `rest/v2`, which is retired and answers 410
- Tokens live in `chrome.storage.local` (`lib/tokens.ts`), never `sync`: a credential should not be copied to every machine on the profile
- Undo reopens the closed tab via `chrome.sessions.restore()`. What was already sent to Readwise or Todoist stays sent; undo is about the tab
- Idle time is close to useless for ranking on a real set: p25 8 days, median 16, p75 19. Ranking by "closure value" is therefore nearly ranking by size alone

## Notes

- Offscreen document is required because MV3 service workers have no DOM/clipboard access
- MV3 CSP forbids inline scripts in HTML, so `offscreen.js` lives in `public/` and is referenced via `<script src>`
- WXT treats same-named `.html` and `.ts` files in `entrypoints/` as duplicate entrypoints, hence the `public/` placement
- Must use `chrome.offscreen` / `chrome.runtime.getContexts` directly (not WXT's `browser.*` polyfill) since these are Chrome-specific APIs
- Clipboard read uses `document.execCommand("paste")`, not `navigator.clipboard.readText()`, because offscreen documents lack focus
