import { getDomainWithoutSuffix } from "tldts";

/**
 * Second-level domain, uppercased, used as both the tab-group name and the
 * same-domain clustering signal. Falls back to the full host for URLs with no
 * public-suffix match (localhost, chrome://, intranet names).
 */
export function domainKey(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  const sld = getDomainWithoutSuffix(host, { allowPrivateDomains: false });
  return (sld || host).toUpperCase();
}

export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
