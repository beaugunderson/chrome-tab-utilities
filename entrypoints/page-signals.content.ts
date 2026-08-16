// Two jobs, one content script on every page.
//
// 1. Track whether the user has typed into a form since the last navigation.
//    Background pings us before auto-discarding the tab; if dirty, we say skip.
// 2. Harvest the page metadata the triage page clusters on. A tab's <title> is
//    often truncated or generic, and this is what lets a pile of news tabs
//    separate by story rather than by publisher.

import { type PageMeta, hasMetaContent, isRealTitle } from "../lib/features";

const MAX_FIELD_LENGTH = 400;
/** How long to keep watching a page that had nothing at DOMContentLoaded. */
// Generous, because only pages that never say anything wait this long: any
// page with a title or a description reports the moment it has one. A heavy JS
// app under a concurrent harvest can take well over five seconds to render.
const SETTLE_TIMEOUT_MS = 15000;
const SETTLE_POLL_MS = 250;

function attr(selector: string, attribute = "content"): string | undefined {
  const el = document.querySelector(selector);
  const value = el?.getAttribute(attribute)?.trim();
  return value ? value.slice(0, MAX_FIELD_LENGTH) : undefined;
}

/** Schema.org type from the first JSON-LD block, e.g. NewsArticle, Product. */
function jsonLdType(): string | undefined {
  const block = document.querySelector('script[type="application/ld+json"]');
  if (!block?.textContent) return undefined;
  try {
    const parsed = JSON.parse(block.textContent);
    const node = Array.isArray(parsed) ? parsed[0] : parsed;
    const type = node?.["@type"];
    if (typeof type === "string") return type;
    if (Array.isArray(type) && typeof type[0] === "string") return type[0];
  } catch {
    // Malformed JSON-LD is common and not worth reporting.
  }
  return undefined;
}

/**
 * The first *visible* h1.
 *
 * Taking `querySelector("h1")` blindly picks up hidden accessibility and
 * skip-link headings: on a real 794-tab set, 73 pages reported their heading
 * as "Command palette", which is GitHub's hidden dialog title. That is pure
 * noise in both the embedding and the cluster label, and it makes every page
 * on such a site look alike.
 */
function visibleHeading(): string | undefined {
  for (const el of document.querySelectorAll("h1")) {
    if (el.closest("[hidden], [aria-hidden='true']")) continue;
    const text = el.textContent?.trim();
    if (!text) continue;
    // offsetParent is null for display:none; the rect catches clip/zero-size
    // tricks that screen-reader-only styles use.
    if ((el as HTMLElement).offsetParent === null) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 4 || rect.width < 4) continue;
    return text;
  }
  return undefined;
}

function harvest(): PageMeta {
  const heading = visibleHeading();
  const siteName = attr('meta[property="og:site_name"]');

  // og:title and the twitter: card tags are server-rendered, so they survive
  // an app that never hydrates. Measured on 78 x.com tabs: og:site_name came
  // through while document.title stayed empty for the full fifteen seconds,
  // which proves the og tags are in the served HTML and only the informative
  // ones were going unread.
  let ogTitle =
    attr('meta[property="og:title"]') ?? attr('meta[name="twitter:title"]');
  // Some sites set og:title to the site's name, which says nothing.
  if (ogTitle && siteName && ogTitle.trim() === siteName.trim()) ogTitle = undefined;

  return {
    description:
      attr('meta[name="description"]') ??
      attr('meta[property="og:description"]') ??
      attr('meta[name="twitter:description"]'),
    ogTitle,
    siteName,
    section:
      attr('meta[property="article:section"]') ??
      attr('meta[name="section"]') ??
      jsonLdType(),
    ogType: attr('meta[property="og:type"]'),
    heading: heading ? heading.slice(0, MAX_FIELD_LENGTH) : undefined,
  };
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: false,
  main() {
    let dirty = false;

    const onInput = (event: Event) => {
      if (dirty) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // Skip clicks on buttons/checkboxes/radios — only mark dirty for actual
      // text-ish entry. `input` event on text fields, textareas, selects, and
      // contenteditable means the user typed/pasted/picked something.
      const tag = target.tagName;
      if (tag === "INPUT") {
        const type = (target as HTMLInputElement).type;
        if (type === "button" || type === "submit" || type === "reset") return;
      }
      dirty = true;
    };

    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "is-form-dirty") {
        // Metadata rides along on the pre-discard check. Once the tab is
        // discarded this script is gone and there is no way to ask again, so
        // this is the last chance to capture it.
        sendResponse({ dirty, url: location.href, meta: harvest() });
        return false;
      }
      // Lets the triage page pull metadata from tabs that were already open
      // before this extension existed, instead of waiting for each to be
      // navigated again.
      if (msg && msg.type === "get-page-meta") {
        sendResponse({ url: location.href, meta: harvest() });
        return false;
      }
    });

    const send = (meta: PageMeta, final: boolean) => {
      // The title travels with the metadata. On a JS app it is often the only
      // thing worth having — x.com puts the whole post in it — and relying on
      // Chrome's copy does not work, because the tab is discarded moments after
      // the app sets it. Captured here, it is ours.
      void chrome.runtime
        .sendMessage({
          type: "page-meta",
          url: location.href,
          title: document.title,
          meta,
          final,
        })
        .catch(() => {});
    };

    /**
     * A title the page set itself, rather than a placeholder. Shares its
     * definition with the rest of the extension so the content script cannot
     * decide it is done on a title the store will then reject.
     */
    const hasRealTitle = () => isRealTitle(document.title, location.href);

    /**
     * Report as soon as there is something to report, and keep looking for a
     * short while if there is not.
     *
     * A single read at DOMContentLoaded is too early for a JS app: on x.com
     * there is no description, no heading, and not even a title until the app
     * renders. Reading once and giving up left 84 of 87 such tabs with nothing,
     * which is the entire population this was built for. Pages that are ready
     * immediately still report immediately, so nothing slows down.
     */
    const reportMeta = () => {
      const attempt = (final: boolean) => {
        const meta = harvest();
        // Shares its definition of "said something" with the rest of the
        // extension. A local copy went stale the moment og:title was added:
        // pages whose only self-description was og:title sat out the whole
        // settle window before reporting what they had had all along.
        if (final || hasMetaContent(meta) || hasRealTitle()) {
          send(meta, final);
          return true;
        }
        return false;
      };

      if (attempt(false)) return;

      const startedAt = Date.now();
      const timer = setInterval(() => {
        const expired = Date.now() - startedAt >= SETTLE_TIMEOUT_MS;
        if (attempt(expired) || expired) clearInterval(timer);
      }, SETTLE_POLL_MS);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", reportMeta, { once: true });
    } else {
      reportMeta();
    }
  },
});
