#!/usr/bin/env node
// End-to-end check of the triage page against a real Chrome profile with the
// built extension loaded. Serves a set of pages, opens them as tabs, then
// asserts the page deals them one at a time in the right order and that each
// card can be acted on. Run after `pnpm build`.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8765;

// Three spaces of different sizes. Ordering is the whole reason the page keeps
// any notion of grouping, so the sizes have to differ for the order to mean
// anything.
const PAGES = [
  ["acct-alpha/one", "Alpha one: notes on kestrels", "Field notes on kestrel migration."],
  ["acct-alpha/two", "Alpha two: nesting survey", "Results of the kestrel nesting survey."],
  ["acct-alpha/three", "Alpha three: winter counts", "Winter raptor counts by transect."],
  ["acct-alpha/four", "Alpha four: ringing data", "Ringing recoveries for the season."],

  ["acct-beta/one", "Beta one: sourdough hydration", "Fixing slack dough and weak gluten."],
  ["acct-beta/two", "Beta two: koji on barley", "Fermentation notes, day nine."],

  ["solo", "A single page on its own", "Nothing else shares this space."],
];

// A JS app that sets its description only after rendering. The page asks each
// loaded tab's content script directly, which is the one piece of harvesting
// left, so this must still be read.
const SPA_RENDER_MS = 900;
const SPA_PAGE = ["spa", "Kestrel migration tracking in the Cascades"];

// Every fixture carries a slow image after its content, because real pages do
// and it is what separates DOMContentLoaded from the load event.
const SLOW_ASSET_MS = 1500;

// The body has to carry real prose: the card fetches a page's text itself, and
// anything shorter than a paragraph is treated as a page with nothing to say.
const FILLER =
  "This paragraph exists so the fixture reads like a page rather than a stub. " +
  "The card fetches a page's own words independently of whether it can be " +
  "framed, and a page with only a heading has nothing worth showing.";

function html(title, description) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:site_name" content="fixtures.local">
</head><body><article><h1>${title}</h1><p>${description}</p><p>${FILLER}</p></article>
<img src="/slow.png" alt="">
</body></html>`;
}

const routes = new Map([
  ...PAGES.map(([slug, title, description]) => [`/${slug}`, html(title, description)]),
  [
    `/${SPA_PAGE[0]}`,
    `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
setTimeout(() => {
  document.title = ${JSON.stringify(SPA_PAGE[1])};
  const m = document.createElement("meta");
  m.name = "description";
  m.content = ${JSON.stringify(SPA_PAGE[1] + ". Rendered after a delay.")};
  document.head.appendChild(m);
}, ${SPA_RENDER_MS});
</script></body></html>`,
  ],
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
  res
    .writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // What most real sites send. The queue preview is only useful if the
      // extension strips this for its own frames.
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    })
    .end(body);
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

// Three posts by three people, so each is a space of its own and the order of
// the bigger spaces above is left alone. Nothing here reaches x.com: the page
// is the empty shell x.com really serves, and the post text comes from the
// syndication endpoint, as it does for real.
const POSTS = [
  ["ada", "1001", "Kestrels hover by flying into the wind at exactly its speed."],
  ["grace", "1002", "A sourdough starter is a pet that you eat."],
  ["edsger", "1003", "Simplicity is a prerequisite for reliability."],
];
await context.route("https://x.com/**", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><title>X</title>" }),
);
await context.route("https://cdn.syndication.twimg.com/**", (route) => {
  const id = new URL(route.request().url()).searchParams.get("id");
  const found = POSTS.find((p) => p[1] === id);
  if (!found) return route.fulfill({ status: 404, body: "" });
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ text: found[2], user: { name: found[0], screen_name: found[0] } }),
  });
});
// Twitter's embed, standing in for the real one: it tells its parent the height
// it needs, which is the only way a cross-origin frame gets sized.
const EMBED_HEIGHT = 321;
await context.route("https://platform.twitter.com/embed/**", (route) => {
  const id = new URL(route.request().url()).searchParams.get("id");
  return route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><p>embed ${id}</p><script>parent.postMessage({"twttr.embed":{
      method:"twttr.private.resize",params:[{width:550,height:${EMBED_HEIGHT},data:{tweet_id:"${id}"}}]}},"*")</script>`,
  });
});

const failures = [];
const consoleErrors = [];
const slugs = [...PAGES.map((p) => p[0]), SPA_PAGE[0]];

try {
  // The service worker's URL carries the extension id.
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`extension id: ${extensionId}`);

  console.log(`opening ${slugs.length} pages…`);
  for (const slug of slugs) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/${slug}`, {
      waitUntil: "domcontentloaded",
    });
  }
  for (const [handle, id] of POSTS) {
    const page = await context.newPage();
    await page.goto(`https://x.com/${handle}/status/${id}`, {
      waitUntil: "domcontentloaded",
    });
  }
  await new Promise((r) => setTimeout(r, SPA_RENDER_MS + 1500));

  const triage = await context.newPage();
  triage.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await triage.goto(`chrome-extension://${extensionId}/triage.html`);

  // The page is the queue: opening it goes straight to work, with no screen in
  // between. Posts come first, as a list.
  await triage.waitForSelector(".queue-card", { timeout: 60000 });
  console.log(`stats: ${await triage.textContent("#stats")}`);
  await checkPostList(triage, context, failures);

  // A JS-rendered description is only readable by asking the content script.
  const spaRead = await worker.evaluate(async (slug) => {
    const key = `tab:http://localhost:8765/${slug}`;
    return Boolean((await chrome.storage.local.get(key))[key]?.meta?.description);
  }, SPA_PAGE[0]);
  console.log(`JS-rendered page read: ${spaRead}`);
  if (!spaRead) failures.push("a JS-rendered description was never read");

  // Order: the biggest space first and whole, because a run of pages from one
  // place is where one decision applies several times over.
  const seen = [];
  const total = Number(
    /of (\d+)/.exec((await triage.textContent(".queue-progress")) ?? "")?.[1] ?? 0,
  );
  // Stop on the last of the two real spaces: the JS-app fixture's body is a
  // script, so there is no prose for the later checks to fetch from it.
  const walk = Math.min(total, PAGES.length - 1);
  for (let step = 0; step < walk; step++) {
    seen.push(await triage.textContent(".queue-url"));
    if (step < walk - 1) {
      await triage.keyboard.press(" ");
      // Each card points the preview somewhere new, and stepping faster than
      // the frames can attach crashes Playwright's frame manager.
      await triage.waitForTimeout(500);
    }
  }
  const spaces = seen.map((url) => new URL(url).pathname.split("/")[1]);
  console.log(`card order: ${spaces.join(", ")}`);
  if (spaces.slice(0, 4).some((s) => s !== "acct-alpha")) {
    failures.push(`the biggest space did not come first and whole: ${spaces}`);
  }
  if (spaces.slice(4, 6).some((s) => s !== "acct-beta")) {
    failures.push(`the second space was not kept together: ${spaces}`);
  }

  // Reloading must land on the same card, so a crash mid-pile is not a restart.
  await triage.reload();
  await triage.waitForSelector(".queue-card", { timeout: 60000 });
  const resumed = await triage.textContent(".queue-url");
  console.log(`resumed at: ${resumed?.replace(`http://localhost:${PORT}`, "")}`);
  if (resumed !== seen.at(-1)) {
    failures.push(`reload lost its place: expected ${seen.at(-1)}, got ${resumed}`);
  }
  if (!new URL(triage.url()).searchParams.get("tab")) {
    failures.push("the URL does not record which card is showing");
  }

  // The card must show the page itself. Title and description are often
  // useless, and every fixture sends X-Frame-Options: DENY, so this only
  // passes if the session rule stripped it.
  await triage.waitForSelector("iframe.queue-preview:not([hidden])", { timeout: 10000 });
  // Read through Playwright's frame API: the preview is cross-origin, so
  // contentDocument is null from the page whether or not it loaded.
  let previewText = null;
  for (let attempt = 0; attempt < 40 && !previewText; attempt++) {
    const frame = triage
      .frames()
      .find((candidate) => candidate.url().startsWith(`http://localhost:${PORT}/`));
    if (frame) {
      previewText = await frame
        .textContent("body")
        .then((t) => (t ?? "").trim().slice(0, 60))
        .catch(() => null);
    }
    if (!previewText) await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`preview rendered: ${JSON.stringify(previewText)}`);
  if (!previewText) {
    failures.push("the queue preview stayed blank; framing headers are not being stripped");
  }

  // A refused preview must be reported rather than left as a grey box, and the
  // only signal for one is a navigation error on the frame. Walking the queue
  // to a card that fails crashes Playwright's frame manager, so what is checked
  // here is that the watcher is live: the realistic way this breaks is the
  // permission going missing, exactly as declarativeNetRequest once did.
  const watching = await triage.evaluate(() => ({
    api: typeof chrome.webNavigation,
    listening: chrome.webNavigation?.onErrorOccurred?.hasListeners?.() ?? false,
  }));
  console.log(
    `refusal watcher: chrome.webNavigation is ${watching.api}, listening: ${watching.listening}`,
  );
  if (watching.api === "undefined") {
    failures.push("chrome.webNavigation is missing; refused previews cannot be detected");
  }
  if (!watching.listening) {
    failures.push("nothing is watching for refused previews while the queue is open");
  }

  // The preview should dominate the card, and the buttons must stay on screen
  // — a frame that grows by pushing the actions out of view is worse than a
  // small one.
  const layout = await triage.evaluate(() => {
    const card = document.querySelector(".queue-card");
    const frame = document.querySelector("iframe.queue-preview");
    const actions = document.querySelector(".queue-actions");
    return {
      card: card.getBoundingClientRect().height,
      frame: frame.getBoundingClientRect().height,
      actionsBottom: actions.getBoundingClientRect().bottom,
      viewport: window.innerHeight,
    };
  });
  const share = Math.round((layout.frame / layout.card) * 100);
  console.log(
    `preview fills ${share}% of the card; actions end at ` +
      `${Math.round(layout.actionsBottom)} of ${layout.viewport}px`,
  );
  if (share < 45) failures.push(`preview only fills ${share}% of the card`);
  if (layout.actionsBottom > layout.viewport) {
    failures.push("the action buttons are pushed off screen");
  }

  // The prose stays out of the way until asked for, then appears on e.
  const proseHiddenAtFirst = await triage.isHidden(".queue-readable");
  await triage.waitForFunction(
    () => !document.querySelector(".queue-prose-toggle")?.disabled,
    undefined,
    { timeout: 15000 },
  );
  await triage.keyboard.press("e");
  await triage.waitForSelector(".queue-readable:not([hidden])", { timeout: 5000 });
  const readableText = (await triage.textContent(".queue-readable")) ?? "";
  console.log(
    `prose hidden until asked: ${proseHiddenAtFirst}; on e: ` +
      `${JSON.stringify(readableText.slice(0, 40))}`,
  );
  if (!proseHiddenAtFirst) failures.push("prose was shown without being asked for");
  if (readableText.trim().length < 20) {
    failures.push("no readable text was fetched for the card");
  }
  await triage.keyboard.press("e");

  // Some things cannot be judged from a preview, so g opens the tab. It must
  // leave the tab open and advance the queue.
  const tabsBefore = context.pages().length;
  const visiting = await triage.textContent(".queue-url");
  await triage.keyboard.press("g");
  await triage.waitForTimeout(800);
  const stillOpen = context.pages().some((p) => p.url() === visiting);
  console.log(`go to tab: ${stillOpen ? "left open" : "LOST"}`);
  if (!stillOpen || context.pages().length !== tabsBefore) {
    failures.push("going to a tab did not leave it open");
  }
  await triage.bringToFront();

  // A save with no token must fail loudly and leave the tab alone: closing
  // after a failed save destroys the thing the save was for.
  const beforeSave = await triage.textContent(".queue-url");
  await triage.keyboard.press("r");
  await triage.waitForSelector(".queue-error:not([hidden])", { timeout: 5000 });
  const saveError = (await triage.textContent(".queue-error")) ?? "";
  console.log(`save with no token: ${saveError.slice(0, 50)}`);
  if (!saveError.includes("Readwise")) failures.push("a failed save said nothing useful");
  if ((await triage.textContent(".queue-url")) !== beforeSave) {
    failures.push("a failed save moved on from the tab it could not save");
  }

  // From the cards, p goes back to whatever posts are still undecided.
  await triage.keyboard.press("p");
  await triage.waitForSelector(".posts-list", { timeout: 5000 });
  const postsLeft = await triage.$$eval(".post-row", (els) => els.length);
  console.log(`back to the list from the cards: ${postsLeft} posts`);
  if (postsLeft !== POSTS.length - 1) {
    failures.push(`the list came back with ${postsLeft} posts, expected ${POSTS.length - 1}`);
  }
  await triage.keyboard.press("p");
  await triage.waitForSelector("iframe.queue-preview", { state: "attached", timeout: 5000 });

  // Escape ends the run and says what happened, rather than dealing again.
  await triage.keyboard.press("Escape");
  await triage.waitForSelector(".queue-card", { state: "detached", timeout: 5000 });
  const done = await triage.textContent("#progress-label");
  console.log(`on escape: ${done}`);
  if (!done?.includes("Done")) failures.push("ending the run reported nothing");
  if (new URL(triage.url()).searchParams.get("tab")) {
    failures.push("the resume parameter outlived the run");
  }
  if (new URL(triage.url()).searchParams.get("view")) {
    failures.push("the view parameter outlived the run");
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

/**
 * The post list, which is what the page opens on when there are posts.
 * Leaves the page on the cards, with one post closed.
 */
async function checkPostList(triage, context, failures) {
  await triage.waitForSelector(".posts-list", { timeout: 60000 });
  const postTexts = await triage.$$eval(".post-text", (els) => els.map((e) => e.textContent));
  console.log(`post list: ${postTexts.length} rows, first ${JSON.stringify(postTexts[0])}`);
  if (postTexts.length !== POSTS.length) {
    failures.push(`expected ${POSTS.length} posts listed, got ${postTexts.length}`);
  }
  if (!POSTS.every((p) => postTexts.includes(p[2]))) {
    failures.push(`the list does not show each post's text: ${JSON.stringify(postTexts)}`);
  }
  if (await triage.$("iframe.queue-preview")) {
    failures.push("the cards were left up behind the post list");
  }

  // Each post is framed as Twitter's embed and takes the height it reports.
  await triage
    .waitForFunction(
      (height) => {
        const frames = [...document.querySelectorAll("iframe.post-embed")];
        return frames.length > 0 && frames.every((f) => f.style.height === `${height}px`);
      },
      EMBED_HEIGHT,
      { timeout: 10000 },
    )
    .catch(() => {});
  const embeds = await triage.$$eval("iframe.post-embed", (els) =>
    els.map((e) => [new URL(e.src).searchParams.get("id"), e.style.height]),
  );
  console.log(`post embeds: ${JSON.stringify(embeds)}`);
  if (
    embeds.length !== POSTS.length ||
    !embeds.every(([id, height]) => POSTS.some((p) => p[1] === id) && height === `${EMBED_HEIGHT}px`)
  ) {
    failures.push(`posts are not framed as sized embeds: ${JSON.stringify(embeds)}`);
  }

  // The same keys act on the highlighted row, and closing really closes.
  const closing = await triage.textContent(".post-row.current .post-text");
  const closingPost = POSTS.find((p) => p[2] === closing);
  await triage.keyboard.press("c");
  await triage.waitForSelector(".post-row.decided", { timeout: 5000 });
  const postStillOpen = context
    .pages()
    .some((p) => p.url().includes(`/status/${closingPost?.[1]}`));
  console.log(`close from the list: ${postStillOpen ? "STILL OPEN" : "closed"}`);
  if (postStillOpen) failures.push("closing a post from the list left its tab open");

  // A reload comes back to the list, without the post that is gone.
  await triage.reload();
  await triage.waitForSelector(".posts-list", { timeout: 60000 });
  const afterReload = await triage.$$eval(".post-row", (els) => els.length);
  console.log(`after reload: ${afterReload} posts listed`);
  if (afterReload !== POSTS.length - 1) {
    failures.push(`reload showed ${afterReload} posts, expected ${POSTS.length - 1}`);
  }
  if (process.env.POSTS_SCREENSHOT) {
    await triage.screenshot({ path: process.env.POSTS_SCREENSHOT });
  }

  // p goes to the cards, and the URL says so, so that a reload stays on them
  // while posts are still waiting.
  await triage.keyboard.press("p");
  await triage.waitForSelector("iframe.queue-preview", { state: "attached", timeout: 5000 });
  if (await triage.$(".posts-list")) failures.push("the post list stayed up over the cards");
  if (new URL(triage.url()).searchParams.get("view") !== "cards") {
    failures.push("the URL does not record that the cards are showing");
  }
}
