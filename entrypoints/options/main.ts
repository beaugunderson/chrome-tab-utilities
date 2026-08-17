import { READWISE_TOKEN_KEY, TODOIST_TOKEN_KEY } from "../../lib/tokens";

const GITHUB_STALE_ORGS_KEY = "githubStaleOrgs";
const SAVE_DEBOUNCE_MS = 400;

const textarea = document.querySelector<HTMLTextAreaElement>("#orgs")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

let saveTimer: ReturnType<typeof setTimeout> | undefined;

// Tokens live in storage.local, not sync: a credential has no business being
// copied to every machine signed into this browser profile.
const tokenFields: Array<[string, HTMLInputElement]> = [
  [READWISE_TOKEN_KEY, document.querySelector<HTMLInputElement>("#readwise")!],
  [TODOIST_TOKEN_KEY, document.querySelector<HTMLInputElement>("#todoist")!],
];

for (const [key, field] of tokenFields) {
  field.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void chrome.storage.local
        .set({ [key]: field.value.trim() })
        .then(() => {
          statusEl.textContent = "Saved";
        });
    }, SAVE_DEBOUNCE_MS);
  });
}

textarea.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
});

async function load() {
  const stored = await chrome.storage.sync.get(GITHUB_STALE_ORGS_KEY);
  const orgs: unknown = stored[GITHUB_STALE_ORGS_KEY];
  if (Array.isArray(orgs)) textarea.value = orgs.join("\n");

  const tokens = await chrome.storage.local.get(
    tokenFields.map(([key]) => key),
  );
  for (const [key, field] of tokenFields) {
    if (typeof tokens[key] === "string") field.value = tokens[key];
  }
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
