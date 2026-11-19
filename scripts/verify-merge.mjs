#!/usr/bin/env node
// End-to-end check of merge-all-windows and domain group colors in a real
// Chrome with the built extension loaded. Builds two windows whose groups
// share titles, merges them, and asserts each title ends up as one group.
// Run after `pnpm build`.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8766;
// What lib/groups.ts colorForDomain gives "LOCALHOST".
const LOCALHOST_COLOR = "green";

const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>fixture ${req.url}</title><h1>${req.url}</h1>`);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const executablePath =
  process.env.CHROME_FOR_TESTING ??
  join(
    process.env.HOME ?? "",
    "Library/Caches/ms-playwright/chromium-1224/chrome-mac-arm64",
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );
const extension = join(import.meta.dirname, "..", ".output", "chrome-mv3");
const profile = mkdtempSync(join(tmpdir(), "tab-tools-merge-"));

const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;

  // An extension page gives the script the chrome.* APIs and a window to
  // merge into.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await page.evaluate(async (port) => {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const open = async (windowId, urls) => {
      const ids = [];
      for (const url of urls) {
        ids.push((await chrome.tabs.create({ windowId, url, active: false })).id);
      }
      return ids;
    };
    const site = (prefix) =>
      [1, 2, 3, 4].map((n) => `http://localhost:${port}/${prefix}${n}`);
    const blank = (n) => Array.from({ length: n }, () => "about:blank");

    const target = (await chrome.windows.getCurrent()).id;
    const other = (await chrome.windows.create({ url: "about:blank" })).id;

    // Same custom title in both windows, differing in case and color.
    const reading = await chrome.tabs.group({
      tabIds: await open(target, blank(2)),
      createProperties: { windowId: target },
    });
    await chrome.tabGroups.update(reading, { title: "Reading", color: "blue" });
    const reading2 = await chrome.tabs.group({
      tabIds: await open(other, blank(2)),
      createProperties: { windowId: other },
    });
    await chrome.tabGroups.update(reading2, { title: "reading", color: "red" });

    // An untitled group, which must survive as its own group.
    await chrome.tabs.group({
      tabIds: await open(other, blank(1)),
      createProperties: { windowId: other },
    });

    // Four same-site tabs per window: the auto-grouper makes a LOCALHOST
    // group in each.
    await open(target, site("a"));
    await open(other, site("b"));
    await settle(2500);

    // Stand in for a group made before domains had fixed colors.
    for (const g of await chrome.tabGroups.query({ windowId: other })) {
      if (g.title === "LOCALHOST") {
        await chrome.tabGroups.update(g.id, { color: "grey" });
      }
    }
    await chrome.windows.update(target, { focused: true });
  }, PORT);

  // The second window has focus while the first window's tabs load, so this
  // also proves a group is created in its tabs' own window.
  const before = await page.evaluate(() => chrome.tabGroups.query({}));
  check(
    before.filter((g) => g.title === "LOCALHOST").length === 2,
    `two LOCALHOST groups before merging (${before.filter((g) => g.title === "LOCALHOST").length})`,
  );

  const response = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "merge-all-windows" }),
  );
  check(response?.ok === true, `merge reported ok (${JSON.stringify(response)})`);

  const after = await page.evaluate(async () => {
    const [windows, groups, tabs] = await Promise.all([
      chrome.windows.getAll({ windowTypes: ["normal"] }),
      chrome.tabGroups.query({}),
      chrome.tabs.query({}),
    ]);
    return {
      windows: windows.length,
      groups: groups.map((g) => ({
        title: g.title ?? "",
        color: g.color,
        tabs: tabs.filter((t) => t.groupId === g.id).length,
      })),
    };
  });
  console.log(JSON.stringify(after.groups));

  check(after.windows === 1, `one window left (${after.windows})`);

  const reading = after.groups.filter((g) => g.title.toUpperCase() === "READING");
  check(reading.length === 1, `one Reading group (${reading.length})`);
  check(reading[0]?.tabs === 4, `Reading holds all four tabs (${reading[0]?.tabs})`);
  check(
    reading[0]?.title === "Reading" && reading[0]?.color === "blue",
    `Reading keeps the target window's title and color (${reading[0]?.title}, ${reading[0]?.color})`,
  );

  const localhost = after.groups.filter((g) => g.title === "LOCALHOST");
  check(localhost.length === 1, `one LOCALHOST group (${localhost.length})`);
  check(localhost[0]?.tabs === 8, `LOCALHOST holds all eight tabs (${localhost[0]?.tabs})`);
  check(
    localhost[0]?.color === LOCALHOST_COLOR,
    `LOCALHOST has its domain color (${localhost[0]?.color})`,
  );

  const untitled = after.groups.filter((g) => g.title === "");
  check(
    untitled.length === 1 && untitled[0].tabs === 1,
    `the untitled group survives on its own (${JSON.stringify(untitled)})`,
  );
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
