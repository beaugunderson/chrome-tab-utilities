/**
 * Close tabs one at a time rather than via chrome.tabs.remove([...ids]): the
 * array form rejects the whole batch if any single id has already gone stale,
 * which would close nothing and throw. Returns how many actually closed.
 */
export async function removeTabs(ids: number[]): Promise<number> {
  const results = await Promise.allSettled(
    ids.map((id) => chrome.tabs.remove(id)),
  );
  return results.filter((r) => r.status === "fulfilled").length;
}
