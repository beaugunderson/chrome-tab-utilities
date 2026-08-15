type Counts = {
  duplicates: number;
  windows: number;
  tabs: number;
  live: number;
  discarded: number;
};

async function refreshCounts() {
  const counts = (await chrome.runtime.sendMessage({
    type: "get-counts",
  })) as Counts | undefined;
  if (!counts) return;
  const dupEl = document.querySelector<HTMLElement>('[data-count="duplicates"]');
  if (dupEl) dupEl.textContent = counts.duplicates > 0 ? String(counts.duplicates) : "";
  const winEl = document.querySelector<HTMLElement>('[data-count="windows"]');
  if (winEl) winEl.textContent = counts.windows > 1 ? String(counts.windows) : "";
  const statusEl = document.querySelector<HTMLElement>(
    '[data-count="discard-status"]',
  );
  if (statusEl) {
    statusEl.textContent = `${counts.live} live · ${counts.discarded} discarded`;
  }
}

document.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!btn) return;
  const type = btn.dataset.action;
  if (!type) return;

  if (type === "open-options") {
    void chrome.runtime.openOptionsPage();
    window.close();
    return;
  }

  if (type === "open-sidepanel") {
    // chrome.sidePanel.open() requires a user gesture, which this click
    // handler provides. Chain without await before the call so the gesture
    // isn't consumed by an earlier async boundary.
    chrome.windows.getCurrent().then((w) => {
      if (w.id !== undefined) void chrome.sidePanel.open({ windowId: w.id });
      window.close();
    });
    return;
  }

  // Fire-and-close: the background service worker runs the action to
  // completion regardless of the popup's lifetime, and some actions (e.g.
  // closing stale GitHub tabs) take 10-15s. Awaiting the response would leave
  // the popup open and looking frozen the whole time.
  void chrome.runtime.sendMessage({ type });
  window.close();
});

void refreshCounts();
