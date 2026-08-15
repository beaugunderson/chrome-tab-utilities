const GITHUB_STALE_ORGS_KEY = "githubStaleOrgs";
const SAVE_DEBOUNCE_MS = 400;

const textarea = document.querySelector<HTMLTextAreaElement>("#orgs")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

let saveTimer: ReturnType<typeof setTimeout> | undefined;

textarea.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
});

async function load() {
  const stored = await chrome.storage.sync.get(GITHUB_STALE_ORGS_KEY);
  const orgs: unknown = stored[GITHUB_STALE_ORGS_KEY];
  if (Array.isArray(orgs)) textarea.value = orgs.join("\n");
}

async function save() {
  const lines = textarea.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  await chrome.storage.sync.set({ [GITHUB_STALE_ORGS_KEY]: lines });
  statusEl.textContent = "Saved";
}

void load();
