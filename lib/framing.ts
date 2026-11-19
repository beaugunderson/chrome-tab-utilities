// Letting the triage queue show a live page.
//
// Most sites refuse to be framed, via X-Frame-Options or a frame-ancestors
// directive in their CSP. A declarativeNetRequest session rule strips both,
// but only for sub-frame requests made by one specific tab — the triage page's
// own — so the rest of the browser keeps its clickjacking protection intact.
// The rule is a session rule, so it dies with the browser regardless.

const RULE_ID = 8801;

/** Allow framing for sub-frames loaded by this tab, and nowhere else. */
export async function allowFramingInTab(tabId: number): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          responseHeaders: [
            {
              header: "x-frame-options",
              operation: "remove" as chrome.declarativeNetRequest.HeaderOperation,
            },
            {
              header: "content-security-policy",
              operation: "remove" as chrome.declarativeNetRequest.HeaderOperation,
            },
            {
              header: "content-security-policy-report-only",
              operation: "remove" as chrome.declarativeNetRequest.HeaderOperation,
            },
          ],
        },
        condition: {
          // Scoped to frames the triage page itself loads in its own tab. The
          // initiator keeps it off frames nested inside a preview, whose
          // initiator is the previewed site, and off anything the tab loads
          // after navigating away from the extension.
          tabIds: [tabId],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            "sub_frame" as chrome.declarativeNetRequest.ResourceType,
          ],
        },
      },
    ],
  });
}

export async function stopAllowingFraming(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
  });
}

/**
 * Report previews the browser refused to load, for this tab's sub-frames.
 *
 * A blocked frame fires the iframe's own load event exactly like a working
 * one and leaves nothing readable behind, since it is cross-origin either way.
 * The navigation is the only place the difference shows: a site that refuses
 * produces net::ERR_BLOCKED_BY_RESPONSE rather than a completed load. Without
 * this a preview that the rule failed to unblock is indistinguishable from one
 * still loading, which is how a dead grey box ends up being the whole card.
 *
 * Returns a function that stops watching.
 */
export function watchBlockedFrames(
  tabId: number,
  onBlocked: (url: string, error: string) => void,
): () => void {
  const listener = (details: { tabId: number; frameId: number; url: string; error: string }) => {
    if (details.tabId !== tabId || details.frameId === 0) return;
    onBlocked(details.url, details.error);
  };
  chrome.webNavigation.onErrorOccurred.addListener(listener);
  return () => chrome.webNavigation.onErrorOccurred.removeListener(listener);
}
