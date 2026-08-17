// One tab at a time, four keys.
//
// Clustering collapses 642 tabs into ~120 groups, but more than half of those
// hold four to nine tabs and are only loosely coherent, so a verdict on the
// group is often the wrong verdict on its members. This decides one tab at a
// time instead, and only borrows from the clustering for ordering: related
// tabs arrive consecutively, so the context of the last decision carries into
// the next one.

export interface QueueItem {
  id: number;
  title: string;
  url: string;
  host: string | null;
  favIconUrl?: string;
  idleDays: number;
  /** Harvested description or post text, shown so a decision needs no click. */
  detail?: string;
  windowId: number;
  /** Cluster this came from, shown to explain why these arrive together. */
  group?: string;
  /** "opened once 44d ago, never returned" — usually the whole decision. */
  engagement?: string;
}

export type Disposition = "save" | "task" | "close" | "skip" | "visit";

export interface QueueHandlers {
  /** The page's prose, fetched. Independent of whether it can be framed. */
  readable?(item: QueueItem): Promise<string | null>;
  /** Returns an error string when the disposition could not be carried out. */
  apply(item: QueueItem, disposition: Disposition): Promise<string | null>;
  /** Bring back whatever the last applied disposition removed. */
  undo(item: QueueItem, disposition: Disposition): Promise<void>;
  finished(counts: Record<Disposition, number>): void;
}

const KEYS: Record<string, Disposition> = {
  s: "save",
  t: "task",
  x: "close",
  " ": "skip",
  // Some things cannot be decided from a preview. Going to the tab counts as
  // dealing with it: the queue moves on, and the tab is left open and waiting.
  g: "visit",
};

const LABELS: Record<Disposition, string> = {
  save: "Readwise",
  task: "Todoist",
  close: "Close",
  skip: "Skip",
  visit: "Go to tab",
};

export function openQueue(items: QueueItem[], handlers: QueueHandlers) {
  if (items.length === 0) return;

  const counts: Record<Disposition, number> = {
    save: 0,
    task: 0,
    close: 0,
    skip: 0,
    visit: 0,
  };
  const history: Array<{ item: QueueItem; disposition: Disposition }> = [];
  let index = 0;
  let busy = false;

  const root = document.createElement("div");
  root.className = "queue";
  root.tabIndex = -1;

  const card = document.createElement("div");
  card.className = "queue-card";

  const progress = document.createElement("div");
  progress.className = "queue-progress";

  const groupLine = document.createElement("div");
  groupLine.className = "queue-group";

  const title = document.createElement("h2");
  title.className = "queue-title";

  const link = document.createElement("a");
  link.className = "queue-url";
  link.target = "_blank";
  link.rel = "noreferrer";

  const engagement = document.createElement("div");
  engagement.className = "queue-engagement";

  const detail = document.createElement("p");
  detail.className = "queue-detail";

  // A live view of the page. Title and description are frequently useless —
  // "Alex Burgin" tells you nothing about an essay on self-respect — and the
  // decision is usually obvious the moment you can see the thing.
  const preview = document.createElement("iframe");
  preview.className = "queue-preview";
  preview.setAttribute("sandbox", "allow-scripts allow-same-origin");
  preview.setAttribute("referrerpolicy", "no-referrer");
  preview.setAttribute("loading", "eager");

  const previewNote = document.createElement("p");
  previewNote.className = "queue-preview-note";
  previewNote.hidden = true;

  // The page's own words, which work whatever the site's framing policy is.
  const readable = document.createElement("pre");
  readable.className = "queue-readable";
  readable.hidden = true;

  const error = document.createElement("p");
  error.className = "queue-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "queue-actions";
  const buttons = new Map<Disposition, HTMLButtonElement>();
  for (const [key, disposition] of Object.entries(KEYS)) {
    const button = document.createElement("button");
    button.className = `ghost queue-key queue-${disposition}`;
    const shortcut = document.createElement("kbd");
    shortcut.textContent = key === " " ? "space" : key;
    button.append(shortcut, document.createTextNode(` ${LABELS[disposition]}`));
    button.addEventListener("click", () => void decide(disposition));
    buttons.set(disposition, button);
    actions.append(button);
  }

  const footer = document.createElement("div");
  footer.className = "queue-footer";
  const undoButton = document.createElement("button");
  undoButton.className = "ghost small";
  undoButton.append(
    Object.assign(document.createElement("kbd"), { textContent: "u" }),
    document.createTextNode(" Undo"),
  );
  undoButton.addEventListener("click", () => void undo());
  const exitButton = document.createElement("button");
  exitButton.className = "ghost small";
  exitButton.append(
    Object.assign(document.createElement("kbd"), { textContent: "esc" }),
    document.createTextNode(" Done"),
  );
  exitButton.addEventListener("click", () => close());
  const tally = document.createElement("span");
  tally.className = "queue-tally";
  footer.append(tally, undoButton, exitButton);

  card.append(
    progress,
    groupLine,
    title,
    link,
    engagement,
    detail,
    readable,
    preview,
    previewNote,
    error,
    actions,
    footer,
  );
  root.append(card);
  document.body.append(root);
  root.focus();

  function render() {
    const item = items[index];
    if (!item) {
      close();
      return;
    }
    progress.textContent = `${index + 1} of ${items.length}`;
    groupLine.textContent = item.group ?? "";
    groupLine.hidden = !item.group;
    title.textContent = item.title;
    link.textContent = item.url;
    link.href = item.url;
    engagement.textContent = item.engagement ?? "";
    engagement.hidden = !item.engagement;
    detail.textContent = item.detail ?? "";
    detail.hidden = !item.detail;
    showPreview(item);
    error.hidden = true;
    tally.textContent =
      `${counts.save} saved · ${counts.task} tasks · ` +
      `${counts.close} closed · ${counts.skip} skipped · ${counts.visit} opened`;
    undoButton.disabled = history.length === 0;
  }

  /**
   * Point the preview at the current page.
   *
   * Blanked between items so the previous page is never left on screen next to
   * the next one's title, which would be worse than showing nothing: the whole
   * point is deciding about what is in front of you.
   */
  function showPreview(item: QueueItem) {
    preview.src = "about:blank";
    previewNote.hidden = true;
    if (!/^https?:/.test(item.url)) {
      preview.hidden = true;
      previewNote.textContent = "No preview for this kind of page.";
      previewNote.hidden = false;
      return;
    }
    preview.hidden = false;
    preview.src = item.url;

    // Fetched separately, because plenty of sites refuse to be framed at all
    // and the decision should not depend on which.
    readable.hidden = true;
    readable.textContent = "";
    const wanted = item.url;
    void handlers.readable?.(item).then((text) => {
      if (!text || items[index]?.url !== wanted) return;
      readable.textContent = text;
      readable.hidden = false;
    });
  }

  async function decide(disposition: Disposition) {
    if (busy) return;
    const item = items[index];
    if (!item) return;
    busy = true;
    for (const button of buttons.values()) button.disabled = true;

    const failure = await handlers.apply(item, disposition);

    busy = false;
    for (const button of buttons.values()) button.disabled = false;

    if (failure) {
      // Staying on the item is the point: a save that silently failed would
      // close the tab and lose it.
      error.textContent = `${LABELS[disposition]} failed: ${failure}`;
      error.hidden = false;
      return;
    }

    counts[disposition]++;
    history.push({ item, disposition });
    index++;
    render();
  }

  async function undo() {
    const last = history.pop();
    if (!last) return;
    await handlers.undo(last.item, last.disposition);
    counts[last.disposition]--;
    index = Math.max(0, index - 1);
    render();
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    handlers.finished(counts);
  }

  function onKey(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "u") {
      event.preventDefault();
      void undo();
      return;
    }
    const disposition = KEYS[event.key.toLowerCase()];
    if (!disposition) return;
    event.preventDefault();
    void decide(disposition);
  }

  document.addEventListener("keydown", onKey, true);
  render();
}
