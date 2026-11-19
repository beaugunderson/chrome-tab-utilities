export type PrState = "open" | "closed" | "unknown";

// Runs in the page context via chrome.scripting.executeScript, so it must stay
// self-contained: no imports, no closure over module state.
//
// Only the PR's own header is read. The header carries a hidden
// `.js-pull-header-details[data-pull-is-open]` hook and a Primer StateLabel
// whose `data-status` is pullOpened, draft, pullMerged or pullClosed. The
// `.State--*` pills on the page belong to timeline cross-references to other
// issues and PRs, so they say nothing about this one: a merged PR referenced
// by an open one carries `.State--open`.
export function readPrStateInPage(): PrState {
  const header = document.querySelector(
    ".js-pull-header-details[data-pull-is-open]",
  );
  if (header) {
    return header.getAttribute("data-pull-is-open") === "true"
      ? "open"
      : "closed";
  }
  const status = document
    .querySelector('[data-component="StateLabel"][data-status]')
    ?.getAttribute("data-status");
  if (status === "pullMerged" || status === "pullClosed") return "closed";
  if (status === "pullOpened" || status === "draft") return "open";
  return "unknown";
}
