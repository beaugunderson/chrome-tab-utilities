// Two jobs, one content script on every page.
//
// 1. Track whether the user has typed into a form since the last navigation.
//    Background pings us before auto-discarding the tab; if dirty, we say skip.
// 2. Harvest the page metadata the triage page clusters on. A tab's <title> is
//    often truncated or generic, and this is what lets a pile of news tabs
//    separate by story rather than by publisher.

interface PageMeta {
  description?: string;
  siteName?: string;
  section?: string;
  ogType?: string;
  heading?: string;
}

const MAX_FIELD_LENGTH = 400;

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

function harvest(): PageMeta {
  const heading = document.querySelector("h1")?.textContent?.trim();
  return {
    description:
      attr('meta[name="description"]') ?? attr('meta[property="og:description"]'),
    siteName: attr('meta[property="og:site_name"]'),
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

    const reportMeta = () => {
      const meta = harvest();
      // Nothing useful on this page; skip the round trip.
      if (Object.values(meta).every((v) => v === undefined)) return;
      // The background may be asleep, and a dropped harvest is not worth
      // retrying: the next visit re-sends it.
      void chrome.runtime
        .sendMessage({ type: "page-meta", url: location.href, meta })
        .catch(() => {});
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", reportMeta, { once: true });
    } else {
      reportMeta();
    }
  },
});
