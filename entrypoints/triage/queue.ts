import type { Preview } from "../../lib/preview";

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
  /**
   * A stand-in for a page that refuses to be framed, if one exists.
   * `stripsHeaders` is false once the browser has refused this page, so the
   * answer can be a still where framing was going to be a live view.
   */
  preview?(url: string, stripsHeaders: boolean): Preview | null;
  /** Whether the header-stripping rule is in force at all. */
  framing?: boolean;
  /** Card to open on, so a reloaded page resumes where it left off. */
  startAt?: number;
  /** Called with each card as it comes up, so its place can be recorded. */
  showing?(item: QueueItem, index: number): void;
  /** The page's prose, fetched. Independent of whether it can be framed. */
  readable?(item: QueueItem): Promise<string | null>;
  /** Returns an error string when the disposition could not be carried out. */
  apply(item: QueueItem, disposition: Disposition): Promise<string | null>;
  /** Bring back whatever the last applied disposition removed. */
  undo(item: QueueItem, disposition: Disposition): Promise<void>;
  finished(counts: Record<Disposition, number>): void;
}

const KEYS: Record<string, Disposition> = {
  r: "save",
  t: "task",
  c: "close",
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

export interface QueueHandle {
  /** The browser refused to load this preview; show something else. */
  previewBlocked(url: string): void;
}

export function openQueue(
  items: QueueItem[],
  handlers: QueueHandlers,
): QueueHandle {
  if (items.length === 0) return { previewBlocked() {} };

  const counts: Record<Disposition, number> = {
    save: 0,
    task: 0,
    close: 0,
    skip: 0,
    visit: 0,
  };
  const history: Array<{ item: QueueItem; disposition: Disposition }> = [];
  let index = Math.min(Math.max(handlers.startAt ?? 0, 0), items.length - 1);
  let busy = false;
  /** What the frame was last pointed at, so a refusal can be matched to it. */
  let framedUrl: string | null = null;

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

  // For pages whose live view cannot be had at all, a still one. A video's
  // thumbnail carries as much of the decision as the player would.
  const previewImage = document.createElement("img");
  previewImage.className = "queue-preview queue-preview-image";
  previewImage.hidden = true;

  const previewNote = document.createElement("p");
  previewNote.className = "queue-preview-note";
  previewNote.hidden = true;

  // The page's own words, which work whatever the site's framing policy is.
  // Kept out of the way until asked for: the preview is the point, and prose
  // that pushes it down is prose in the wrong place.
  const readable = document.createElement("pre");
  readable.className = "queue-readable";
  readable.hidden = true;

  let proseOpen = false;
  let proseText: string | null = null;
  const proseToggle = document.createElement("button");
  proseToggle.className = "ghost small queue-prose-toggle";
  proseToggle.addEventListener("click", () => toggleProse());

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

  // Laid out across rather than down: six stacked lines of chrome were
  // costing the preview a third of the card for information that reads fine
  // side by side.
  const metaRow = document.createElement("div");
  metaRow.className = "queue-meta";
  metaRow.append(progress, groupLine, engagement, proseToggle);

  const headingRow = document.createElement("div");
  headingRow.className = "queue-heading";
  headingRow.append(title, link);

  card.append(
    metaRow,
    headingRow,
    detail,
    readable,
    preview,
    previewImage,
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
    handlers.showing?.(item, index);
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
  function showPreview(item: QueueItem, stripsHeaders = handlers.framing !== false) {
    framedUrl = null;
    preview.src = "about:blank";
    preview.hidden = true;
    previewImage.hidden = true;
    previewImage.removeAttribute("src");
    previewNote.hidden = true;
    if (!/^https?:/.test(item.url)) {
      previewNote.textContent = "No preview for this kind of page.";
      previewNote.hidden = false;
      return;
    }

    // Some sites need a stand-in: an address built to be framed, or a still
    // image where nothing framable exists.
    const stand = handlers.preview?.(item.url, stripsHeaders) ?? null;
    if (stand) {
      previewNote.textContent = stand.note;
      previewNote.hidden = false;
    }
    if (stand?.kind === "image") {
      previewImage.hidden = false;
      previewImage.onerror = stand.fallback
        ? () => {
            previewImage.onerror = null;
            previewImage.src = stand.fallback as string;
          }
        : null;
      previewImage.src = stand.url;
    } else {
      preview.hidden = false;
      framedUrl = stand?.url ?? item.url;
      preview.src = framedUrl;
    }

    // Fetched separately, because plenty of sites refuse to be framed at all
    // and the decision should not depend on which.
    proseText = null;
    readable.textContent = "";
    syncProse();
    const wanted = item.url;
    void handlers.readable?.(item).then((text) => {
      if (items[index]?.url !== wanted) return;
      proseText = text;
      readable.textContent = text ?? "";
      syncProse();
    });
  }

  /**
   * Fall back after the browser refuses to load the framed page.
   *
   * A refused frame renders as a grey box that reads like a page still
   * loading, so the card has to say what happened and put whatever else it
   * has in that space: the page's own picture where there is one, and its
   * text, which is fetched and so does not depend on framing at all.
   */
  function previewBlocked(url: string) {
    const item = items[index];
    if (!item || framedUrl !== url) return;
    showPreview(item, false);
    if (preview.hidden === false) {
      // Nothing framable and no still: the frame is worse than empty space.
      preview.hidden = true;
      preview.src = "about:blank";
      framedUrl = null;
    }
    if (previewNote.hidden) {
      previewNote.textContent = `${hostOf(url)} refused to be framed.`;
      previewNote.hidden = false;
    }
    proseOpen = true;
    syncProse();
  }

  /** The toggle stays put between cards, so it is set once and not per tab. */
  function toggleProse() {
    proseOpen = !proseOpen;
    syncProse();
  }

  function syncProse() {
    readable.hidden = !proseOpen || !proseText;
    proseToggle.textContent = proseOpen ? "Hide text (e)" : "Show text (e)";
    proseToggle.disabled = !proseText;
    proseToggle.title = proseText
      ? "Show the page's text"
      : "No readable text could be fetched for this page";
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
    if (event.key === "e") {
      event.preventDefault();
      toggleProse();
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

  return { previewBlocked };
}

/** The host of a URL, for saying which site refused. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "this page";
  }
}
