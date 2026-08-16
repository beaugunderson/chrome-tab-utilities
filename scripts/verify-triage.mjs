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

// Distinct pages that nothing is known about: no <title>, so Chrome falls back to showing the URL — which is what a
// tab restored from a previous session but never opened looks like, and no
// description or h1 either. All that is knowable is the URL, so they embed
// near-identically — calling them duplicates of each other would be wrong, and
// so would letting them bridge unrelated clusters.
const BARE_PAGES = ["bare-1", "bare-2", "bare-3"];

// A JS app: nothing in the served HTML, everything set after a delay. This is
// what x.com looks like, and reading only at DOMContentLoaded found nothing on
// 84 of 87 such tabs.
const SPA_RENDER_MS = 900;
const SPA_PAGES = [
  ["spa-1", "Kestrel migration tracking in the Cascades"],
  ["spa-2", "Kestrel nesting survey results"],
];

// The x.com shape exactly: a JS app that sets only a title, never any meta
// tags. The title is the whole of what the page ever says about itself, so
// capturing it is the difference between clustering these and not.
const TITLE_ONLY_PAGES = [
  ["title-only-1", "Fermentation notes: koji on barley, day nine"],
  ["title-only-2", "Fermentation notes: second koji batch went sour"],
];

// Every fixture page carries a slow image after its content. Real pages are
// full of these, and they are exactly what `status: "complete"` waits for and
// DOMContentLoaded does not — so without one here the harvest timing would
// look identical either way and prove nothing.
const SLOW_ASSET_MS = 1500;

function html(title, description, siteName) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:site_name" content="${siteName}">
<meta property="og:type" content="article">
</head><body><h1>${title}</h1><p>${description}</p>
<img src="/slow.png" alt="">
</body></html>`;
}

const routes = new Map([
  ...PAGES.map(([slug, title, description, site]) => [
    `/${slug}`,
    html(title, description, site),
  ]),
  ...SPA_PAGES.map(([slug, title]) => [
    `/${slug}`,
    `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
setTimeout(() => {
  document.title = ${JSON.stringify(title)};
  const m = document.createElement("meta");
  m.name = "description";
  m.content = ${JSON.stringify(title + ". Field notes on raptor populations.")};
  document.head.appendChild(m);
}, ${SPA_RENDER_MS});
</script></body></html>`,
  ]),
  // Served with the site name as a placeholder title, replaced by the real one
  // only once the app renders. This is what x.com does, and a lenient check
  // treats the placeholder as a real title and gives up immediately.
  ...TITLE_ONLY_PAGES.map(([slug, title]) => [
    `/${slug}`,
    `<!doctype html><html><head><meta charset="utf-8"><title>localhost</title></head><body><script>
setTimeout(() => { document.title = ${JSON.stringify(title)}; }, ${SPA_RENDER_MS});
</script></body></html>`,
  ]),
  // Only og:site_name, exactly what x.com serves. Not content: every page on
  // the site carries the same value, so it cannot identify any of them.
  ...BARE_PAGES.map((slug) => [
    `/${slug}`,
    `<!doctype html><html><head><meta charset="utf-8"><meta property="og:site_name" content="Bare"><meta property="og:type" content="article"></head><body><p>x</p></body></html>`,
  ]),
]);

const server = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/slow.png") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(64));
    }, SLOW_ASSET_MS);
    return;
  }
  const body = routes.get(path);
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

  console.log(`opening ${PAGES.length + SPA_PAGES.length + TITLE_ONLY_PAGES.length + BARE_PAGES.length} pages…`);
  for (const slug of [...PAGES.map((p) => p[0]), ...SPA_PAGES.map((p) => p[0]), ...TITLE_ONLY_PAGES.map((p) => p[0]), ...BARE_PAGES]) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/${slug}`, {
      waitUntil: "domcontentloaded",
    });
  }
  // Long enough for the JS-app fixtures to render and the settle window to
  // report them.
  await new Promise((r) => setTimeout(r, SPA_RENDER_MS + 2500));

  // A page that renders its title and description in JS must still be read.
  // Reading once at DOMContentLoaded found nothing on these.
  const spaRead = await worker.evaluate(async (slugs) => {
    const out = [];
    for (const slug of slugs) {
      const key = `tab:http://localhost:8765/${slug}`;
      const stored = await chrome.storage.local.get(key);
      out.push(Boolean(stored[key]?.meta?.description));
    }
    return out;
  }, SPA_PAGES.map((p) => p[0]));
  console.log(
    `JS-rendered pages read: ${spaRead.filter(Boolean).length}/${spaRead.length}`,
  );

  // A JS app that only ever sets a title must still be captured. Relying on
  // Chrome's tab title does not work here: the tab is discarded moments after
  // the app sets it, so the page's own report is the only dependable copy.
  const titlesKept = await worker.evaluate(async (slugs) => {
    const out = [];
    for (const slug of slugs) {
      const key = `tab:http://localhost:8765/${slug}`;
      const stored = await chrome.storage.local.get(key);
      out.push(stored[key]?.title ?? null);
    }
    return out;
  }, TITLE_ONLY_PAGES.map((p) => p[0]));
  console.log(`title-only pages captured: ${JSON.stringify(titlesKept)}`);
  for (const [i, [, expected]] of TITLE_ONLY_PAGES.entries()) {
    if (titlesKept[i] !== expected) {
      failures.push(
        `title-only page ${i + 1} stored ${JSON.stringify(titlesKept[i])}, expected the rendered title`,
      );
    }
  }
  if (spaRead.some((ok) => !ok)) {
    failures.push(
      `${spaRead.filter((ok) => !ok).length} JS-rendered pages produced no metadata; ` +
        "the settle window is not waiting for them to render",
    );
  }

  // Metadata has to be captured *before* a tab is discarded: once it is
  // unloaded there is no content script to ask, and on a long-lived tab set
  // with auto-discard on that is nearly every tab. The capture rides along on
  // the pre-discard form-dirty check, so exercise exactly that message.
  //
  // The tabs are not actually discarded here: discarding a Playwright-attached
  // page takes the whole browser down.
  const preDiscard = await worker.evaluate(async (bareSlugs) => {
    const all = await chrome.tabs.query({ url: "http://localhost:8765/*" });
    // The bare fixtures have no description by design, so they are not part of
    // this count.
    const tabs = all.filter(
      (t) => !bareSlugs.some((slug) => t.url.endsWith(`/${slug}`)),
    );
    let withMeta = 0;
    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "is-form-dirty",
        });
        if (response?.meta?.description) withMeta++;
      } catch {
        /* no content script */
      }
    }
    return { asked: tabs.length, withMeta };
  }, [...BARE_PAGES, ...SPA_PAGES.map((p) => p[0]), ...TITLE_ONLY_PAGES.map((p) => p[0])]);
  console.log(
    `pre-discard capture: ${preDiscard.withMeta}/${preDiscard.asked} tabs returned metadata`,
  );
  if (preDiscard.withMeta < preDiscard.asked) {
    failures.push(
      `pre-discard capture missed ${preDiscard.asked - preDiscard.withMeta} tabs; ` +
        "discarded tabs would cluster on titles alone",
    );
  }

  // The backlog harvest resolves on the content script's DOMContentLoaded push
  // and discards immediately, rather than waiting for `status: "complete"`.
  // Measure the gap it is exploiting: with a slow asset on the page, complete
  // lands well after the metadata is already available.
  const timing = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      url: "http://localhost:8765/pr-1",
    });
    return await new Promise((resolve) => {
      const t0 = Date.now();
      let metaAt = null;
      let completeAt = null;
      const done = () => {
        chrome.runtime.onMessage.removeListener(onMessage);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve({ metaAt, completeAt });
      };
      const onMessage = (msg, sender) => {
        if (msg?.type === "page-meta" && sender.tab?.id === tab.id) {
          metaAt ??= Date.now() - t0;
        }
      };
      const onUpdated = (id, info) => {
        if (id === tab.id && info.status === "complete") {
          completeAt ??= Date.now() - t0;
          done();
        }
      };
      chrome.runtime.onMessage.addListener(onMessage);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.reload(tab.id);
      setTimeout(done, 6000);
    });
  });
  console.log(
    `harvest timing: metadata at ${timing.metaAt}ms, ` +
      `page ${timing.completeAt === null ? "never reported complete" : `complete at ${timing.completeAt}ms`}`,
  );
  if (timing.metaAt === null) {
    failures.push("no metadata push arrived after reload");
  } else if (timing.completeAt !== null && timing.metaAt >= timing.completeAt - 500) {
    failures.push(
      `metadata arrived at ${timing.metaAt}ms vs complete at ${timing.completeAt}ms; ` +
        "waiting for complete would cost nothing, so the harvest gains nothing",
    );
  }

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

  const metaShare = Number(/(\d+)% with page metadata/.exec(stats ?? "")?.[1] ?? 0);
  console.log(`page metadata coverage: ${metaShare}%`);
  if (metaShare < 90) {
    failures.push(`only ${metaShare}% of tabs have page metadata`);
  }

  // Nothing is discarded in this run, so there is no backlog to offer. A CSS
  // display rule can silently beat the `hidden` attribute, which is exactly
  // how this and the selection footer once showed permanently.
  const backlogShown = await triage.isVisible("#backlog");
  const selectionShown = await triage.isVisible("#selection");
  console.log(
    `hidden-when-empty — backlog: ${!backlogShown}, selection footer: ${!selectionShown}`,
  );
  if (backlogShown) failures.push("backlog prompt shown with nothing to harvest");
  if (selectionShown) failures.push("selection footer shown with nothing selected");

  const defaultPosition = await triage.inputValue("#cut");
  const defaultClusters = await triage.$$eval(
    "main > .cluster, main > .tab-row",
    (r) => r.length,
  );
  console.log(
    `slider opens at ${defaultPosition}/1000 → ${defaultClusters} clusters`,
  );

  const dupeVisible = await triage.isVisible("#dupes");
  console.log(`near-duplicate panel shown: ${dupeVisible}`);
  if (!dupeVisible) {
    failures.push("the identical-story fixture did not register as a duplicate");
  }

  // The bare fixtures embed almost identically because there is nothing to
  // read, not because they are the same page. Calling them duplicates is the
  // false positive this gate exists to prevent.
  const dupeTitles = await triage.$$eval("#dupes .tab-title", (rows) =>
    rows.map((r) => r.textContent ?? ""),
  );
  const bareInDupes = dupeTitles.filter((t) => t.includes("/bare-")).length;
  console.log(
    `near-duplicate rows: ${dupeTitles.length}, of which unread lookalikes: ${bareInDupes}`,
  );
  if (bareInDupes > 0) {
    failures.push(
      `${bareInDupes} unread lookalike tabs were reported as near-duplicates`,
    );
  }
  // The genuine duplicate must survive the gate.
  if (!dupeTitles.some((t) => t.includes("Fed holds interest rates steady"))) {
    failures.push("the real duplicate was lost along with the false positives");
  }

  // Those same tabs must be kept out of the tree, where they would otherwise
  // sit equidistant from everything and chain unrelated clusters together.
  const unknownShown = await triage.isVisible("#unknown");
  const unknownRows = await triage.$$eval("#unknown .tab-row", (r) => r.length);
  console.log(`unidentified section: shown=${unknownShown}, ${unknownRows} tabs`);
  if (unknownRows !== BARE_PAGES.length) {
    failures.push(
      `expected ${BARE_PAGES.length} unidentified tabs, found ${unknownRows}`,
    );
  }
  // The section tells you reading them fixes the grouping, so it has to offer
  // a way to do that.
  const readButton = await triage.$$eval("#unknown button", (b) =>
    b.map((x) => x.textContent ?? ""),
  );
  console.log(`unidentified actions: ${JSON.stringify(readButton)}`);
  if (!readButton.some((t) => t.includes("Read all"))) {
    failures.push("unidentified section says to read them but offers no button");
  }

  // The section has to say why the last attempt came to nothing, next to the
  // tabs rather than in the header where it gets lost.
  const diagnosis = await triage.$$eval("#unknown .note", (n) =>
    n.map((x) => x.textContent ?? ""),
  );
  if (!diagnosis.some((t) => /been read yet|Last attempt:/.test(t))) {
    failures.push(`unidentified section reports no read outcome: ${JSON.stringify(diagnosis)}`);
  }

  const clusteredBare = await triage.$$eval("main .tab-title", (rows) =>
    rows.filter((r) => (r.textContent ?? "").includes("/bare-")).length,
  );
  if (clusteredBare > 0) {
    failures.push(`${clusteredBare} unidentified tabs leaked into the clusters`);
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

  // Quality, not just plumbing: the fixtures are four obvious topics, so at
  // some slider position each should sit whole in one cluster. Membership is
  // read off the rendered rows by title.
  const TOPICS = {
    "pull requests": ["pr-1", "pr-2", "pr-3", "pr-4"],
    ceasefire: ["news-1", "news-2", "news-3"],
    // The mortgage calculator belongs here: it is the same task as looking at
    // listings, which is exactly the kind of link a domain-based grouping
    // misses and this one should not.
    "house hunting": ["house-1", "house-2", "house-3"],
    "ml reading": ["ml-1", "ml-2"],
  };
  const titleOf = new Map(PAGES.map(([slug, title]) => [slug, title]));

  const clusterMemberships = () =>
    triage.$$eval("main > .cluster", (sections) =>
      sections.map((s) =>
        [...s.querySelectorAll(".tab-row .tab-title")].map(
          (t) => t.textContent ?? "",
        ),
      ),
    );

  const topicResults = {};
  for (const [name, slugs] of Object.entries(TOPICS)) {
    const wanted = slugs.map((s) => titleOf.get(s));
    let bestPosition = null;
    for (const position of [200, 350, 500, 650, 800, 950]) {
      await setCut(position);
      const groups = await clusterMemberships();
      const whole = groups.some((titles) =>
        wanted.every((w) => titles.includes(w)),
      );
      if (whole) {
        bestPosition = position;
        break;
      }
    }
    topicResults[name] = bestPosition;
  }

  console.log("\ntopic recovered whole at slider position:");
  for (const [name, position] of Object.entries(topicResults)) {
    console.log(`  ${name}: ${position ?? "never"}`);
    if (position === null) {
      failures.push(`"${name}" never grouped into a single cluster`);
    }
  }

  // The stronger claim, and the one tuning tends to break: the view you get
  // without touching the slider should already be right. Every topic whole,
  // and none of them fused with another.
  await triage.reload();
  await triage.waitForSelector("#granularity:not([hidden])", { timeout: 120000 });
  const openingGroups = await clusterMemberships();

  // Fusing two topics into one cluster is a defect: the grouping is asserting
  // something false. Splitting one topic across clusters is not — the default
  // is one point on a slider, and every topic is separately checked to be
  // recoverable above. So this fails on mixing and only reports on splitting.
  const topicOf = new Map();
  for (const [name, slugs] of Object.entries(TOPICS)) {
    for (const slug of slugs) topicOf.set(titleOf.get(slug), name);
  }

  for (const titles of openingGroups) {
    const present = [...new Set(titles.map((t) => topicOf.get(t)).filter(Boolean))];
    if (present.length > 1) {
      failures.push(
        `default cut fuses ${present.join(" + ")} into one cluster: ${titles.join("; ")}`,
      );
    }
  }

  const whole = Object.entries(TOPICS).filter(([, slugs]) => {
    const wanted = slugs.map((s) => titleOf.get(s));
    return openingGroups.some((titles) => wanted.every((w) => titles.includes(w)));
  }).length;
  const topicCount = Object.keys(TOPICS).length;
  console.log(
    `default cut: no topics fused; ${whole}/${topicCount} also whole, ` +
      `across ${openingGroups.length} multi-tab clusters`,
  );

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
  const clusterable = PAGES.length + SPA_PAGES.length + TITLE_ONLY_PAGES.length;
  console.log(`tab rows visible without clicking: ${openRows} of ${clusterable}`);
  if (openRows < clusterable) {
    failures.push(
      `only ${openRows} of ${clusterable} tabs visible without clicking`,
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

  // Ticking every tab in a cluster has to tick the cluster itself, and leave
  // it indeterminate while only some are ticked.
  await setCut(500);
  const checkState = await triage.evaluate(() => {
    const cluster = [...document.querySelectorAll("main > .cluster")].find(
      (c) => c.querySelectorAll(".cluster-body > .tab-row").length >= 2,
    );
    const box = cluster.querySelector(".cluster-check");
    const rows = [...cluster.querySelectorAll(".cluster-body > .tab-row")];
    const boxes = rows.map((r) => r.querySelector('input[type="checkbox"]'));

    const click = (b) => {
      b.click();
    };
    const read = () => ({ checked: box.checked, mixed: box.indeterminate });

    const start = read();
    click(boxes[0]);
    const partial = read();
    for (const b of boxes.slice(1)) click(b);
    const all = read();
    click(boxes[0]);
    const unticked = read();
    return { start, partial, all, unticked, count: boxes.length };
  });

  console.log(
    `cluster checkbox over ${checkState.count} tabs: ` +
      `none=${JSON.stringify(checkState.start)} ` +
      `some=${JSON.stringify(checkState.partial)} ` +
      `all=${JSON.stringify(checkState.all)}`,
  );
  if (checkState.start.checked || checkState.start.mixed) {
    failures.push("cluster checkbox was not clear with nothing selected");
  }
  if (!checkState.partial.mixed || checkState.partial.checked) {
    failures.push("cluster checkbox is not indeterminate with some tabs ticked");
  }
  if (!checkState.all.checked || checkState.all.mixed) {
    failures.push("cluster checkbox did not become checked with every tab ticked");
  }
  if (checkState.unticked.checked || !checkState.unticked.mixed) {
    failures.push("cluster checkbox stayed checked after unticking a tab");
  }

  await triage.reload();
  await triage.waitForSelector("#granularity:not([hidden])", { timeout: 120000 });

  // Closing a tab must not re-cluster. Rebuilding the tree over the remaining
  // tabs rescales the slider and reshuffles the groups, so every close used to
  // silently change the granularity underneath you.
  await setCut(650);
  const beforeClose = {
    position: await triage.inputValue("#cut"),
    readout: await triage.textContent("#cut-readout"),
    groups: await clusterMemberships(),
  };

  await triage.click("main .cluster-body .tab-row .tab-close");
  await triage.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

  const afterClose = {
    position: await triage.inputValue("#cut"),
    readout: await triage.textContent("#cut-readout"),
    groups: await clusterMemberships(),
  };

  console.log(
    `closing one tab: slider ${beforeClose.position} → ${afterClose.position}, ` +
      `${beforeClose.readout} → ${afterClose.readout}`,
  );
  if (beforeClose.position !== afterClose.position) {
    failures.push(
      `closing a tab moved the slider from ${beforeClose.position} to ${afterClose.position}`,
    );
  }
  if (beforeClose.groups.length !== afterClose.groups.length) {
    failures.push(
      `closing a tab changed the cluster count from ${beforeClose.groups.length} to ${afterClose.groups.length}`,
    );
  }
  // Exactly one tab should have vanished, and no tab should have moved between
  // clusters.
  const flatBefore = beforeClose.groups.flat();
  const flatAfter = afterClose.groups.flat();
  if (flatBefore.length - flatAfter.length !== 1) {
    failures.push(
      `closing one tab removed ${flatBefore.length - flatAfter.length} rows`,
    );
  }
  // Compared by membership, not by position: clusters are ordered by closure
  // value, which depends on size, so losing a tab legitimately reorders them.
  // What must not happen is a tab moving from one cluster to another.
  for (const after of afterClose.groups) {
    const intact = beforeClose.groups.some((before) =>
      after.every((title) => before.includes(title)),
    );
    if (!intact) {
      failures.push(
        `closing a tab regrouped these into one cluster: ${after.join("; ")}`,
      );
    }
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
