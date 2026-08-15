import { defineConfig } from "wxt";

export default defineConfig({
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
    ],
    host_permissions: ["*://github.com/*"],
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
    },
  },
});
