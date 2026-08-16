// Per-URL cache backing the triage page: harvested page metadata, manual tags,
// the opener graph, and the embedding itself.
//
// Chrome drops openerTabId and resets lastAccessed on restart, so both are
// snapshotted here to survive it. Embeddings are quantized to int8, which is
// ample for cosine similarity and keeps a 600-tab set around 230KB.

import type { PageMeta } from "./features";

const KEY_PREFIX = "tab:";
/** Entries beyond this are evicted oldest-first after a triage run. */
const MAX_ENTRIES = 20000;

export interface TabRecord {
  /** Base64 int8 embedding, absent until the tab has been embedded. */
  v?: string;
  /** Feature fingerprint the vector was computed from. */
  fp?: string;
  meta?: PageMeta;
  /**
   * Title as the page itself reported it. Chrome shows the URL for a tab it
   * never loaded, and a title a JS app sets does not reliably survive the tab
   * being discarded straight afterwards, so this is the dependable copy.
   */
  title?: string;
  /**
   * When the backlog harvest last loaded this page, whether or not it found
   * anything. Plenty of pages carry no description, og tags or h1 at all, and
   * without recording the attempt they are reloaded again on every pass
   * forever.
   */
  metaTried?: number;
  tags?: string[];
  /** URL of the tab this one was opened from. */
  opener?: string;
  /** Last time this URL was the active tab, as epoch milliseconds. */
  seen?: number;
}

function keyFor(url: string): string {
  return KEY_PREFIX + url;
}

export function quantize(vec: Float32Array): string {
  const bytes = new Uint8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const clamped = Math.max(-1, Math.min(1, vec[i]));
    // Int8 range mapped onto a signed byte, read back below as a two's
    // complement value.
    bytes[i] = Math.round(clamped * 127) & 0xff;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function dequantize(encoded: string): Float32Array {
  const binary = atob(encoded);
  const out = new Float32Array(binary.length);
  let norm = 0;
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    const signed = byte > 127 ? byte - 256 : byte;
    const value = signed / 127;
    out[i] = value;
    norm += value * value;
  }
  // Rounding to int8 nudges the vector off the unit sphere; restore it so
  // cosine similarity stays a plain dot product.
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= norm;
  }
  return out;
}

export async function loadRecords(
  urls: string[],
): Promise<Map<string, TabRecord>> {
  const keys = urls.map(keyFor);
  const raw = (await chrome.storage.local.get(keys)) as Record<string, TabRecord>;
  const out = new Map<string, TabRecord>();
  for (const url of urls) {
    const record = raw[keyFor(url)];
    if (record) out.set(url, record);
  }
  return out;
}

/** One batched write for a whole run; never call this per tab. */
export async function saveRecords(records: Map<string, TabRecord>) {
  if (records.size === 0) return;
  const payload: Record<string, TabRecord> = {};
  for (const [url, record] of records) payload[keyFor(url)] = record;
  await chrome.storage.local.set(payload);
}

/** Read-modify-write a single record. Used by the background listeners. */
export async function patchRecord(url: string, patch: Partial<TabRecord>) {
  if (!url || !url.startsWith("http")) return;
  const key = keyFor(url);
  const existing = ((await chrome.storage.local.get(key)) as Record<string, TabRecord>)[key];
  const merged: TabRecord = { ...existing, ...patch };
  if (patch.meta && existing?.meta) {
    merged.meta = { ...existing.meta, ...patch.meta };
  }
  await chrome.storage.local.set({ [key]: merged });
}

export async function setTags(url: string, tags: string[]) {
  await patchRecord(url, { tags: tags.length > 0 ? tags : undefined });
}

/**
 * Drop the least recently seen entries once the cache outgrows MAX_ENTRIES.
 * Reads the whole store, so this runs after a triage run rather than inline.
 */
export async function pruneStore(): Promise<number> {
  const all = (await chrome.storage.local.get(null)) as Record<string, TabRecord>;
  const entries = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
  if (entries.length <= MAX_ENTRIES) return 0;

  entries.sort((a, b) => (all[a]?.seen ?? 0) - (all[b]?.seen ?? 0));
  const doomed = entries.slice(0, entries.length - MAX_ENTRIES);
  await chrome.storage.local.remove(doomed);
  return doomed.length;
}
