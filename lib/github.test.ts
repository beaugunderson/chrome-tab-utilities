// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readPrStateInPage } from "./github";

// Markup trimmed from real github.com PR pages. The header carries a hidden
// `.js-pull-header-details` hook and a Primer StateLabel; the `.State--*`
// pills belong to timeline cross-references to *other* issues and PRs.
function header(isOpen: boolean, status: string): string {
  return `
    <header data-component="SplitPageLayout.Header">
      <div class="js-pull-header-details" data-pull-is-open="${isOpen}" hidden=""></div>
      <span class="prc-StateLabel-StateLabel-Iawzp" data-component="StateLabel"
            data-size="medium" data-status="${status}">label</span>
    </header>`;
}

function crossReference(state: "open" | "merged" | "closed" | "draft"): string {
  return `
    <div class="TimelineItem">
      <span class="State State--${state} State--small">${state}</span>
      <a href="/canvas-medical/canvas-agents/pull/456">another PR</a>
    </div>`;
}

function page(html: string) {
  document.body.innerHTML = html;
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("reads a merged PR as closed", () => {
  page(header(false, "pullMerged"));
  expect(readPrStateInPage()).toBe("closed");
});

it("reads an open PR as open", () => {
  page(header(true, "pullOpened"));
  expect(readPrStateInPage()).toBe("open");
});

it("reads a merged PR as closed when an open PR references it", () => {
  page(header(false, "pullMerged") + crossReference("open"));
  expect(readPrStateInPage()).toBe("closed");
});

it("reads an open PR as open when a merged PR references it", () => {
  page(header(true, "pullOpened") + crossReference("merged"));
  expect(readPrStateInPage()).toBe("open");
});

it("reads the state label when the header hook is absent", () => {
  page(`<span data-component="StateLabel" data-status="pullMerged">Merged</span>`);
  expect(readPrStateInPage()).toBe("closed");
  page(`<span data-component="StateLabel" data-status="pullClosed">Closed</span>`);
  expect(readPrStateInPage()).toBe("closed");
  page(`<span data-component="StateLabel" data-status="draft">Draft</span>`);
  expect(readPrStateInPage()).toBe("open");
});

it("reports unknown for a page whose only pill is a cross-reference", () => {
  page(crossReference("merged"));
  expect(readPrStateInPage()).toBe("unknown");
});

it("reports unknown for a page with no state at all", () => {
  page("<main>404</main>");
  expect(readPrStateInPage()).toBe("unknown");
});
