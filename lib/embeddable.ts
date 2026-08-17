// Some sites cannot be framed at their normal address but publish one that
// can be.
//
// YouTube's /watch pages send x-frame-options: SAMEORIGIN, while /embed/<id>
// sends no such header at all — it exists to be framed. Rewriting to it is
// both more reliable than stripping headers and more useful, since the result
// is a playable video rather than a page of chrome.

export interface Embeddable {
  url: string;
  /** Shown so it is clear the preview is not the page itself. */
  note: string;
}

function youtubeId(parsed: URL): { id: string; start?: string } | null {
  const host = parsed.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return id ? { id, start: seconds(parsed) } : null;
  }
  if (host !== "youtube.com") return null;

  if (parsed.pathname === "/watch") {
    const id = parsed.searchParams.get("v");
    return id ? { id, start: seconds(parsed) } : null;
  }
  // /shorts/<id> and /live/<id> both embed the same way.
  const match = /^\/(?:shorts|live|embed)\/([\w-]+)/.exec(parsed.pathname);
  return match ? { id: match[1], start: seconds(parsed) } : null;
}

/** A t= or start= parameter, in whole seconds, if the URL carries one. */
function seconds(parsed: URL): string | undefined {
  const raw = parsed.searchParams.get("t") ?? parsed.searchParams.get("start");
  if (!raw) return undefined;
  const plain = /^\d+$/.exec(raw);
  if (plain) return plain[0];
  // "1h2m3s" as YouTube writes it in a shared link.
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!parts || !parts.slice(1).some(Boolean)) return undefined;
  const total =
    Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  return total > 0 ? String(total) : undefined;
}

/**
 * The framable equivalent of a URL, when the site publishes one.
 *
 * Returns null when the page should simply be framed as-is.
 */
export function embeddableUrl(url: string): Embeddable | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const video = youtubeId(parsed);
  if (video) {
    const start = video.start ? `?start=${video.start}` : "";
    return {
      url: `https://www.youtube.com/embed/${video.id}${start}`,
      note: "Showing the YouTube player; the watch page refuses to be framed.",
    };
  }

  const vimeo = /^(?:www\.)?vimeo\.com$/.test(parsed.hostname)
    ? /^\/(\d+)/.exec(parsed.pathname)
    : null;
  if (vimeo) {
    return {
      url: `https://player.vimeo.com/video/${vimeo[1]}`,
      note: "Showing the Vimeo player.",
    };
  }

  return null;
}
