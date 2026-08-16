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
      "unlimitedStorage",
      "scripting",
    ],
    host_permissions: [
      "*://github.com/*",
      // One-time download of the embedding model on first triage run. Weights
      // are cached by the browser afterward, so this is never hit again.
      "https://huggingface.co/*",
      "https://*.hf.co/*",
      // Reads x.com posts as JSON. The page itself exposes nothing per-post to
      // a background tab, and this is one request instead of one page load.
      "https://cdn.syndication.twimg.com/*",
    ],
    // The ONNX runtime backing the embedding model is WebAssembly. Chrome's
    // default extension CSP omits wasm-unsafe-eval, and this is the most
    // permissive policy MV3 allows.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
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
        description: "Open the tab triage page (semantic clusters)",
      },
    },
  },
});
