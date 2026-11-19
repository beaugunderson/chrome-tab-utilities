import { defineConfig } from "wxt";

// Stamped at build time so every artifact can say which build it came from.
// Content scripts do not update in already-open tabs until those tabs
// navigate, so a stale one can answer a message from a fresh page and the
// result is indistinguishable from the feature not working.
const BUILD_ID = new Date().toISOString();

export default defineConfig({
  vite: () => ({
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  }),
  manifest: {
    name: "Tab Tools",
    description: "Keyboard shortcuts and popup actions for copy/paste tab URLs, group tabs by domain, sort tabs, close duplicate tabs, merge windows, and split tabs into a new window",
    action: {
      default_popup: "popup.html",
      default_title: "Tab Tools",
    },
    side_panel: {
      default_path: "sidepanel.html",
    },
    permissions: [
      "tabs",
      "tabGroups",
      "clipboardRead",
      "clipboardWrite",
      "offscreen",
      "sidePanel",
      "alarms",
      "storage",
      "scripting",
      // Undo in the one-at-a-time queue reopens the tab it just closed.
      "sessions",
      // Visit counts separate the tabs you actually use from the pile.
      "history",
      // Strips X-Frame-Options and frame-ancestors so the queue can show a
      // live preview. The rule is a session rule scoped to the triage tab
      // alone, so it is not a browser-wide hole.
      "declarativeNetRequestWithHostAccess",
      // A blocked preview fires the iframe's load event exactly like a working
      // one, so this is the only way to know a site refused. Adds no warning
      // beyond the one `history` already carries.
      "webNavigation",
    ],
    // One entry, because every named host this talks to is a subset of it and
    // Chrome grants or withholds the whole list together. Previewing and
    // reading an arbitrary tab is what needs the breadth, and it is no broader
    // than the content script already running on <all_urls>. What it is spent
    // on: reading PR state from github.com, x.com posts as JSON from
    // cdn.syndication.twimg.com, previewing and fetching the text of any tab,
    // and saving to readwise.io and api.todoist.com.
    host_permissions: ["<all_urls>"],
    commands: {
      "copy-tabs": {
        suggested_key: {
          default: "MacCtrl+Shift+C",
          mac: "Command+Shift+C",
        },
        description: "Copy tab URLs to clipboard",
      },
      "paste-tabs": {
        suggested_key: {
          default: "MacCtrl+Shift+V",
          mac: "Command+Shift+V",
        },
        description: "Open URLs from clipboard as tabs",
      },
      "group-tabs-by-domain": {
        description: "Group tabs in current window by domain",
      },
      "close-duplicate-tabs": {
        description: "Close duplicate tabs across all windows",
      },
      "merge-all-windows": {
        description: "Merge all windows into the current window",
      },
      "new-window-with-current-and-tabs-to-right": {
        description:
          "New window with the current tab and the tabs to its right",
      },
      "new-window-with-tabs-to-right": {
        description: "New window with the tabs to the right of the current tab",
      },
      "sort-tabs-by-url": {
        description:
          "Sort tabs in current window by URL (alphabetizing groups, sorting within each group)",
      },
      "sort-tabs-by-title": {
        description:
          "Sort tabs in current window by title (alphabetizing groups, sorting within each group)",
      },
      "close-stale-github-tabs": {
        description:
          "Close merged/closed PR tabs, /pulls list pages, and workflow run pages for the configured GitHub owners",
      },
      "triage-tabs": {
        description: "Open the tab triage page (one tab at a time)",
      },
    },
  },
});
