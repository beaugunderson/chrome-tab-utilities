#!/usr/bin/env node
// End-to-end check of the triage page against a real Chrome profile with the
// built extension loaded. Serves a set of pages across four obvious topics,
// opens them as tabs, then asserts the page clusters them and reports what it
// found. Run after `pnpm build`.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8765;

const PAGES = [
  ["pr-1", "Fix scribe transcript provider attribution", "Pull request review for the hyperscribe plugin runner.", "github.local"],
  ["pr-2", "KOALA-6561 plugin runner timings regression", "Pull request discussing plugin runner latency percentiles.", "github.local"],
  ["pr-3", "Add pytest coverage for the plugin sandbox", "Pull request adding tests to the plugin sandbox loader.", "github.local"],
  ["pr-4", "Review: prek mypy hook skipped on push", "Pull request changing the prek hook configuration.", "github.local"],

  ["news-1", "Ceasefire talks resume after third round", "Negotiators met again as the ceasefire deadline approached.", "news.local"],
  ["news-2", "Ceasefire summit ends without agreement", "Diplomats left the ceasefire summit with no signed accord.", "news.local"],
  ["news-3", "Analysis: what the ceasefire means for the region", "An analysis of the ceasefire negotiations and their fallout.", "news.local"],

  ["fed-1", "Fed holds interest rates steady", "The Federal Reserve left the benchmark interest rate unchanged.", "news.local"],
  ["fed-2", "Markets react to the Fed rate decision", "Stocks moved after the Federal Reserve interest rate decision.", "news.local"],

  ["house-1", "3 bed bungalow in Ballard for sale", "Real estate listing for a Ballard bungalow with a large yard.", "realestate.local"],
  ["house-2", "Ballard craftsman home listing", "Real estate listing for a craftsman home in Ballard, Seattle.", "realestate.local"],
  ["house-3", "Mortgage rate calculator for home buyers", "Estimate monthly mortgage payments when buying a home.", "realestate.local"],

  ["ml-1", "HDBSCAN versus k-means for text clustering", "Comparing density clustering and k-means on sentence embeddings.", "docs.local"],
  ["ml-2", "Sentence embeddings with MiniLM", "How to compute sentence embeddings using a MiniLM model.", "docs.local"],

  // Same story on two sites: different URLs, so exact-URL dedupe cannot see
  // it, but the embeddings should.
  ["dupe-a", "Fed holds interest rates steady", "The Federal Reserve left the benchmark interest rate unchanged.", "wire.local"],
  ["dupe-b", "Fed holds interest rates steady", "The Federal Reserve left the benchmark interest rate unchanged.", "reprint.local"],
];

function html(title, description, siteName) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:site_name" content="${siteName}">
<meta property="og:type" content="article">
</head><body><h1>${title}</h1><p>${description}</p></body></html>`;
}

const routes = new Map(
  PAGES.map(([slug, title, description, site]) => [
    `/${slug}`,
    html(title, description, site),
  ]),
);

const server = createServer((req, res) => {
  const body = routes.get((req.url ?? "").split("?")[0]);
  if (!body) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});
await new Promise((resolve) => server.listen(PORT, resolve));

const profile = mkdtempSync(join(tmpdir(), "triage-verify-"));
const extension = join(process.cwd(), ".output", "chrome-mv3");

// Playwright's bundled Chromium, in a throwaway profile that never touches the
// real one. This build loads unpacked extensions headlessly.
// System Chrome does not: it reports no extensions and never registers the
// service worker. Point CHROME_FOR_TESTING at another build to override.
const executablePath =
  process.env.CHROME_FOR_TESTING ??
  join(
    process.env.HOME ?? "",
    "Library/Caches/ms-playwright/chromium-1224/chrome-mac-arm64",
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );

const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});

const failures = [];
const consoleErrors = [];

try {
  // The service worker's URL carries the extension id.
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`extension id: ${extensionId}`);

  console.log(`opening ${PAGES.length} pages…`);
  for (const [slug] of PAGES) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/${slug}`, {
      waitUntil: "domcontentloaded",
    });
  }
  // Give the content script's harvest a moment to reach the background.
  await new Promise((r) => setTimeout(r, 1500));

  const triage = await context.newPage();
  triage.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  triage.on("requestfailed", (r) =>
    failures.push(`${r.failure()?.errorText} ${r.url()}`),
  );
  triage.on("response", (r) => {
    if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url()}`);
  });

  // Which ONNX runtime files actually get fetched decides what copy-ort must
  // stage; a missing one is a 404 at first inference, not a build error.
  const ortRequests = new Set();
  triage.on("request", (r) => {
    const match = /\/ort\/([^?]+)$/.exec(r.url());
    if (match) ortRequests.add(match[1]);
  });

  const started = Date.now();
  await triage.goto(`chrome-extension://${extensionId}/triage.html`);

  // Clustering is done when the granularity slider is revealed. Generous
  // timeout: the first run downloads the model.
  await triage.waitForSelector("#granularity:not([hidden])", { timeout: 300000 });
  const elapsed = Date.now() - started;

  const stats = await triage.textContent("#stats");
  console.log(`\nclustered in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`stats: ${stats}`);
  console.log(`ort files fetched: ${[...ortRequests].join(", ") || "(none)"}`);
  // copy-ort.mjs stages a specific pair. If a transformers.js upgrade changes
  // which runtime files ORT asks for, catch it here rather than as a 404 the
  // first time a real triage run tries to embed anything.
  const staged = new Set(readdirSync(join(extension, "ort")));
  for (const file of ortRequests) {
    if (!staged.has(file)) {
      failures.push(`ORT requested ${file}, which copy-ort.mjs does not stage`);
    }
  }
  if (ortRequests.size === 0) {
    failures.push("no ORT runtime files were fetched; wasmPaths may be ignored");
  }

  const dupeVisible = await triage.isVisible("#dupes");
  console.log(`near-duplicate panel shown: ${dupeVisible}`);
  if (!dupeVisible) {
    failures.push("the identical-story fixture did not register as a duplicate");
  }

  const report = async () => {
    const names = await triage.$$eval(
      "main > .cluster > .cluster-header, main > .tab-row",
      (rows) =>
        rows.map((r) =>
          r.classList.contains("tab-row")
            ? {
                name: r.querySelector(".tab-title")?.textContent ?? "",
                meta: "1 tab",
              }
            : {
                name: r.querySelector(".cluster-name")?.textContent ?? "",
                meta: r.querySelector(".cluster-meta")?.textContent ?? "",
              },
        ),
    );
    for (const { name, meta } of names) console.log(`  - ${name}  (${meta})`);
    return names;
  };

  console.log("\nclusters at the default cut:");
  const atDefault = await report();

  // Renders are coalesced to one animation frame, so settle before reading.
  const setCut = async (position) => {
    await triage.fill("#cut", String(position));
    await triage.dispatchEvent("#cut", "input");
    await triage.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  };

  // Slider must change granularity monotonically. Counts every cluster plus
  // every top-level singleton, which now renders as a plain row.
  const clusterCount = () =>
    triage.$$eval("main > .cluster, main > .tab-row", (r) => r.length);

  const counts = [];
  for (const position of [100, 300, 500, 700, 900]) {
    await setCut(position);
    counts.push(await clusterCount());
  }
  console.log(`\ncluster count across slider positions: ${counts.join(" → ")}`);
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[i - 1]) {
      failures.push(`slider not monotonic: ${counts.join(",")}`);
      break;
    }
  }

  // Clusters start expanded, so every tab must be on screen with no clicking.
  // Counted inside clusters plus top-level singletons; the duplicates panel
  // repeats rows, so it is excluded.
  const visibleTabs = () =>
    triage.$$eval(
      "main .cluster-body .tab-row, main > .tab-row",
      (r) => r.length,
    );

  await setCut(500);
  const openRows = await visibleTabs();
  console.log(`tab rows visible without clicking: ${openRows} of ${PAGES.length}`);
  if (openRows < PAGES.length) {
    failures.push(
      `only ${openRows} of ${PAGES.length} tabs visible without clicking`,
    );
  }

  // Collapse all, then expand all, and confirm the state round-trips.
  await triage.click("#fold-all");
  const collapsed = await triage.$$eval(
    "main .cluster-body .tab-row",
    (r) => r.length,
  );
  console.log(`tab rows inside clusters after Collapse all: ${collapsed}`);
  if (collapsed !== 0) {
    failures.push(`Collapse all left ${collapsed} tab rows on screen`);
  }

  await triage.click("#fold-all");
  const reopened = await visibleTabs();
  console.log(`tab rows after Expand all: ${reopened}`);
  if (reopened !== openRows) {
    failures.push(`Expand all restored ${reopened}, expected ${openRows}`);
  }

  // Collapsing one cluster must hide only that cluster's tabs.
  await triage.click("main > .cluster .chevron");
  const afterOne = await visibleTabs();
  console.log(`tab rows after collapsing one cluster: ${afterOne}`);
  if (afterOne >= reopened) failures.push("collapsing one cluster hid nothing");
  if (afterOne === 0) failures.push("collapsing one cluster hid everything");

  if (atDefault.length < 2) {
    failures.push(`expected several clusters, got ${atDefault.length}`);
  }
  if (atDefault.length >= PAGES.length) {
    failures.push("every tab landed in its own cluster; nothing grouped");
  }
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

if (consoleErrors.length > 0) {
  console.log(`\nconsole errors (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
}
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
  process.exit(1);
}
console.log("\nall checks passed");
