const TAB_GROUP_ID_NONE = -1;

const GROUP_COLORS: Record<`${chrome.tabGroups.Color}`, string> = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#9334e6",
  cyan: "#007b83",
  orange: "#e8710a",
};

const DEFAULT_FAVICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='%239aa0a6'/></svg>",
  );

let boundWindowId: number | undefined;
let pendingRender = false;
let scrollRestoreTop = 0;

const root = document.getElementById("tabs") as HTMLElement;

async function init() {
  const w = await chrome.windows.getCurrent();
  boundWindowId = w.id;
  setupListeners();
  await render();
}

function scheduleRender() {
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => {
    pendingRender = false;
    void render();
  });
}

function setupListeners() {
  const matchesWindow = (windowId: number | undefined) =>
    windowId !== undefined && windowId === boundWindowId;

  chrome.tabs.onCreated.addListener((tab) => {
    if (matchesWindow(tab.windowId)) scheduleRender();
  });
  chrome.tabs.onRemoved.addListener((_id, info) => {
    if (matchesWindow(info.windowId)) scheduleRender();
  });
  chrome.tabs.onUpdated.addListener((_id, _info, tab) => {
    if (matchesWindow(tab.windowId)) scheduleRender();
  });
  chrome.tabs.onMoved.addListener((_id, info) => {
    if (matchesWindow(info.windowId)) scheduleRender();
  });
  chrome.tabs.onActivated.addListener((info) => {
    if (matchesWindow(info.windowId)) scheduleRender();
  });
  chrome.tabs.onAttached.addListener((_id, info) => {
    if (matchesWindow(info.newWindowId)) scheduleRender();
  });
  chrome.tabs.onDetached.addListener((_id, info) => {
    if (matchesWindow(info.oldWindowId)) scheduleRender();
  });
  chrome.tabs.onReplaced.addListener(() => scheduleRender());

  chrome.tabGroups.onCreated.addListener((g) => {
    if (matchesWindow(g.windowId)) scheduleRender();
  });
  chrome.tabGroups.onUpdated.addListener((g) => {
    if (matchesWindow(g.windowId)) scheduleRender();
  });
  chrome.tabGroups.onRemoved.addListener((g) => {
    if (matchesWindow(g.windowId)) scheduleRender();
  });
  chrome.tabGroups.onMoved.addListener((g) => {
    if (matchesWindow(g.windowId)) scheduleRender();
  });
}

async function render() {
  if (boundWindowId === undefined) return;

  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId: boundWindowId }),
    chrome.tabGroups.query({ windowId: boundWindowId }),
  ]);
  tabs.sort((a, b) => a.index - b.index);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const tabCountByGroup = new Map<number, number>();
  for (const t of tabs) {
    if (t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE) {
      tabCountByGroup.set(t.groupId, (tabCountByGroup.get(t.groupId) ?? 0) + 1);
    }
  }

  scrollRestoreTop = root.scrollTop;

  const frag = document.createDocumentFragment();
  let previousGroupId: number = TAB_GROUP_ID_NONE;

  for (const tab of tabs) {
    const gid = tab.groupId ?? TAB_GROUP_ID_NONE;

    if (gid !== previousGroupId && gid !== TAB_GROUP_ID_NONE) {
      const group = groupsById.get(gid);
      if (group) {
        frag.appendChild(
          renderGroupHeader(group, tabCountByGroup.get(gid) ?? 0),
        );
      }
    }
    previousGroupId = gid;

    const group = gid !== TAB_GROUP_ID_NONE ? groupsById.get(gid) : undefined;
    // Mirror Chrome's collapsed-group behavior: hide tabs in collapsed groups.
    if (group?.collapsed) continue;

    frag.appendChild(renderTab(tab, group));
  }

  root.replaceChildren(frag);
  root.scrollTop = scrollRestoreTop;
}

function renderGroupHeader(
  group: chrome.tabGroups.TabGroup,
  count: number,
): HTMLElement {
  const header = document.createElement("div");
  header.className = "group-header";
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", String(!group.collapsed));
  header.style.setProperty("--group-color", GROUP_COLORS[group.color]);

  const chevron = document.createElement("span");
  chevron.className = "group-chevron";
  chevron.textContent = group.collapsed ? "▶" : "▼";

  const title = document.createElement("span");
  title.className = "group-title";
  title.textContent = group.title || "(untitled)";

  const countEl = document.createElement("span");
  countEl.className = "group-count";
  countEl.textContent = String(count);

  header.appendChild(chevron);
  header.appendChild(title);
  header.appendChild(countEl);

  header.addEventListener("click", () => {
    void chrome.tabGroups.update(group.id, { collapsed: !group.collapsed });
  });

  return header;
}

function renderTab(
  tab: chrome.tabs.Tab,
  group: chrome.tabGroups.TabGroup | undefined,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "tab";
  if (tab.active) row.classList.add("active");
  if (tab.status === "loading") row.classList.add("loading");
  if (group) {
    row.classList.add("in-group");
    row.style.setProperty("--group-color", GROUP_COLORS[group.color]);
  }
  row.setAttribute("role", "listitem");

  const favicon = document.createElement("img");
  favicon.className = "favicon";
  favicon.alt = "";
  favicon.src = tab.favIconUrl || DEFAULT_FAVICON;
  favicon.addEventListener("error", () => {
    if (favicon.src !== DEFAULT_FAVICON) favicon.src = DEFAULT_FAVICON;
  });

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = tab.title || tab.url || "(untitled)";
  title.title = tab.url ?? "";

  row.appendChild(favicon);

  if (tab.pinned) {
    const pin = document.createElement("span");
    pin.className = "pin-indicator";
    pin.textContent = "📌";
    pin.title = "Pinned";
    row.appendChild(pin);
  }

  row.appendChild(title);

  if (tab.audible || tab.mutedInfo?.muted) {
    const audio = document.createElement("span");
    audio.className = "audio-indicator";
    if (tab.mutedInfo?.muted) audio.classList.add("muted");
    audio.textContent = tab.mutedInfo?.muted ? "🔇" : "🔊";
    row.appendChild(audio);
  }

  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.setAttribute("aria-label", "Close tab");
  close.title = "Close tab";
  close.textContent = "×";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    if (tab.id !== undefined) void chrome.tabs.remove(tab.id);
  });
  row.appendChild(close);

  row.addEventListener("click", () => {
    if (tab.id !== undefined) void chrome.tabs.update(tab.id, { active: true });
  });

  row.addEventListener("auxclick", (event) => {
    // Middle-click to close, matching Chrome's own tab strip.
    if (event.button === 1 && tab.id !== undefined) {
      event.preventDefault();
      void chrome.tabs.remove(tab.id);
    }
  });

  return row;
}

void init();
