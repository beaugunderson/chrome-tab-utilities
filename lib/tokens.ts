// Where the outbound credentials live.
//
// chrome.storage.local, not sync: a token has no business being copied to
// every machine signed into this browser profile.

export const READWISE_TOKEN_KEY = "readwiseToken";
export const TODOIST_TOKEN_KEY = "todoistToken";

export async function readTokens(): Promise<{
  readwise?: string;
  todoist?: string;
}> {
  const stored = await chrome.storage.local.get([
    READWISE_TOKEN_KEY,
    TODOIST_TOKEN_KEY,
  ]);
  const clean = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    readwise: clean(stored[READWISE_TOKEN_KEY]),
    todoist: clean(stored[TODOIST_TOKEN_KEY]),
  };
}
