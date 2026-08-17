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
          // Scoped to the one tab, and to frames within it.
          tabIds: [tabId],
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
