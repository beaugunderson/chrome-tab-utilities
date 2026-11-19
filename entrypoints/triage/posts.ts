import {
  type Counts,
  type Disposition,
  type OtherView,
  type QueueItem,
  KEYS,
  LABELS,
  OTHER_VIEW_KEY,
  emptyCounts,
} from "./queue";
import {
  parseEmbedMessage,
  tweetEmbedUrl,
  tweetIdFromUrl,
} from "../../lib/tweets";

// Every x.com post at once, each shown as Twitter's own embed.
//
// x.com refuses to be framed and never renders in a background tab, but its
// embed frames anywhere and draws the post as the site does: media, quoted
// post, link card. Laid out as a grid, several are readable at a glance and
// the next is already on screen. The decision is still per post, with the same
// keys as the card.

/** Until an embed reports the height it needs. */
const EMBED_START_HEIGHT = 240;

export interface PostListHandlers {
  /** Returns an error string when the disposition could not be carried out. */
  apply(item: QueueItem, disposition: Disposition): Promise<string | null>;
  /** Bring back whatever the last applied disposition removed. */
  undo(item: QueueItem, disposition: Disposition): Promise<void>;
  finished(counts: Counts): void;
  /** A tally shared with the other view, so switching does not reset it. */
  counts?: Counts;
  other?: OtherView;
}

export function openPostList(items: QueueItem[], handlers: PostListHandlers) {
  const counts = handlers.counts ?? emptyCounts();
  /** What was decided for each row, by position. Undecided rows are absent. */
  const outcomes = new Map<number, Disposition>();
  const history: number[] = [];
  let cursor = 0;
  let busy = false;

  const root = document.createElement("div");
  root.className = "queue";
  root.tabIndex = -1;

  const card = document.createElement("div");
  card.className = "queue-card";

  const heading = document.createElement("div");
  heading.className = "queue-meta";
  const progress = document.createElement("div");
  progress.className = "queue-progress";
  heading.append(progress);

  const list = document.createElement("div");
  list.className = "posts-list";

  const theme = window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
  /** Each embed's frame and what stands in for it when it has no post, by post id. */
  const embeds = new Map<
    string,
    { frame: HTMLIFrameElement; text: HTMLElement; author: HTMLElement }
  >();

  const rows = items.map((item, at) => {
    const row = document.createElement("div");
    row.className = "post-row";
    row.addEventListener("click", () => {
      cursor = at;
      render();
    });

    const byline = document.createElement("div");
    byline.className = "post-byline";
    const author = document.createElement("span");
    author.className = "post-author";
    author.textContent = item.byline ?? item.host ?? "";
    byline.append(author);
    for (const extra of [item.engagement, item.origin]) {
      if (!extra) continue;
      const span = document.createElement("span");
      span.textContent = extra;
      byline.append(span);
    }
    const outcome = document.createElement("span");
    outcome.className = "post-outcome";
    byline.append(outcome);

    // What is on record for the post, shown when the embed has nothing: a
    // deleted or protected post leaves its text, or only its address.
    const text = document.createElement("div");
    text.className = "post-text";
    text.textContent = item.detail ?? item.url;

    row.append(byline);
    const id = tweetIdFromUrl(item.url);
    if (id) {
      const frame = document.createElement("iframe");
      frame.className = "post-embed";
      frame.loading = "lazy";
      frame.style.height = `${EMBED_START_HEIGHT}px`;
      frame.src = tweetEmbedUrl(id, theme);
      // The embed names its own author; the line above keeps what it lacks.
      text.hidden = true;
      author.hidden = true;
      embeds.set(id, { frame, text, author });
      row.append(frame);
    }
    row.append(text);
    list.append(row);
    return { row, outcome, frame: id ? embeds.get(id)!.frame : null };
  });

  function onEmbedMessage(event: MessageEvent) {
    const message = parseEmbedMessage(event.origin, event.data);
    const embed = message && embeds.get(message.id);
    if (!message || !embed) return;
    if (message.kind === "resize") {
      embed.frame.style.height = `${message.height}px`;
    } else {
      embed.frame.remove();
      embed.text.hidden = false;
      embed.author.hidden = false;
    }
  }
  window.addEventListener("message", onEmbedMessage);

  // A click inside an embed moves keyboard focus into its frame, where the
  // page's keys cannot be heard. Take the click as choosing that post and
  // bring focus back.
  function onBlur() {
    setTimeout(() => {
      const at = rows.findIndex(({ frame }) => frame === document.activeElement);
      if (at === -1) return;
      cursor = at;
      root.focus();
      render();
    });
  }
  window.addEventListener("blur", onBlur);

  const error = document.createElement("p");
  error.className = "queue-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "queue-actions";
  const buttons: HTMLButtonElement[] = [];
  for (const [key, disposition] of Object.entries(KEYS)) {
    const button = document.createElement("button");
    button.className = `ghost queue-key queue-${disposition}`;
    const shortcut = document.createElement("kbd");
    shortcut.textContent = key === " " ? "space" : key;
    button.append(shortcut, document.createTextNode(` ${LABELS[disposition]}`));
    button.addEventListener("click", () => void decide(disposition));
    buttons.push(button);
    actions.append(button);
  }

  const footer = document.createElement("div");
  footer.className = "queue-footer";
  const tally = document.createElement("span");
  tally.className = "queue-tally";
  footer.append(tally);
  if (handlers.other) {
    const otherButton = document.createElement("button");
    otherButton.className = "ghost small";
    otherButton.append(
      Object.assign(document.createElement("kbd"), { textContent: OTHER_VIEW_KEY }),
      document.createTextNode(` ${handlers.other.label}`),
    );
    otherButton.addEventListener("click", () => switchView());
    footer.append(otherButton);
  }
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
  footer.append(undoButton, exitButton);

  card.append(heading, list, error, actions, footer);
  root.append(card);
  document.body.append(root);
  root.focus();

  function render() {
    progress.textContent =
      `${outcomes.size} of ${items.length} posts decided · j / k to move`;
    rows.forEach(({ row, outcome }, at) => {
      const decided = outcomes.get(at);
      row.classList.toggle("current", at === cursor);
      row.classList.toggle("decided", decided !== undefined);
      outcome.textContent = decided ? LABELS[decided] : "";
    });
    // jsdom has no layout and so no scrollIntoView.
    rows[cursor]?.row.scrollIntoView?.({ block: "nearest" });
    tally.textContent =
      `${counts.save} saved · ${counts.task} tasks · ` +
      `${counts.close} closed · ${counts.skip} skipped · ${counts.visit} opened`;
    undoButton.disabled = history.length === 0;
  }

  /** The next row still waiting for a decision, looking forward first. */
  function nextUndecided(from: number): number | null {
    for (let step = 1; step <= items.length; step++) {
      const at = (from + step) % items.length;
      if (!outcomes.has(at)) return at;
    }
    return null;
  }

  function move(by: number) {
    cursor = Math.min(Math.max(cursor + by, 0), items.length - 1);
    error.hidden = true;
    render();
  }

  async function decide(disposition: Disposition) {
    const at = cursor;
    if (busy || outcomes.has(at)) return;
    busy = true;
    for (const button of buttons) button.disabled = true;

    const failure = await handlers.apply(items[at], disposition);

    busy = false;
    for (const button of buttons) button.disabled = false;

    if (failure) {
      // The row stays undecided: a save that silently failed would close the
      // tab and lose it.
      error.textContent = `${LABELS[disposition]} failed: ${failure}`;
      error.hidden = false;
      return;
    }

    error.hidden = true;
    counts[disposition]++;
    outcomes.set(at, disposition);
    history.push(at);
    const next = nextUndecided(at);
    if (next === null) {
      // The last post is not the end of the run when there is another view.
      if (handlers.other) switchView();
      else close();
      return;
    }
    cursor = next;
    render();
  }

  async function undo() {
    const at = history.pop();
    if (at === undefined) return;
    const disposition = outcomes.get(at)!;
    await handlers.undo(items[at], disposition);
    counts[disposition]--;
    outcomes.delete(at);
    cursor = at;
    render();
  }

  function dismiss() {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("message", onEmbedMessage);
    window.removeEventListener("blur", onBlur);
    root.remove();
  }

  function close() {
    dismiss();
    handlers.finished(counts);
  }

  /** Hand over to the other view without ending the run. */
  function switchView() {
    if (busy || !handlers.other) return;
    dismiss();
    handlers.other.open();
  }

  function onKey(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "u") {
      event.preventDefault();
      void undo();
      return;
    }
    if (event.key === OTHER_VIEW_KEY && handlers.other) {
      event.preventDefault();
      switchView();
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
