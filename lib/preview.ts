// What to show for a page that will not frame at its own address.
//
// Most of this is handled by the session rule that strips framing headers, so
// the answer for nearly every page is "frame it as it is". Two sites need
// more.
//
// Vimeo publishes a player address that frames from anywhere, which is cleaner
// than the page around it, so it gets used whether or not headers are being
// stripped.
//
// YouTube's own player is the opposite: it refuses any embedder whose origin
// is not http(s), so /embed/<id> answers "Error 153" on a chrome-extension://
// page no matter what. Measured across youtube.com and youtube-nocookie.com,
// with and without sandbox, referrerpolicy and origin=, on two videos — all
// eight combinations fail, while the same embed from http://localhost does
// not. The watch page has no such check: with x-frame-options stripped it
// frames and plays. So YouTube needs a still frame only when headers are not
// being stripped, and nothing at all when they are.

export type Preview =
  | { kind: "frame"; url: string; note: string }
  | {
      kind: "image";
      url: string;
      /** Used when the first image does not exist. */
      fallback?: string;
      note: string;
    };

/** The video id in a YouTube URL, in any of the shapes YouTube writes. */
function youtubeId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
  if (host !== "youtube.com") return null;
  if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
  // /shorts/<id> and /live/<id> both name a video the same way.
  return /^\/(?:shorts|live|embed)\/([\w-]+)/.exec(parsed.pathname)?.[1] ?? null;
}

/**
 * The stand-in preview for a URL, when the site needs one.
 *
 * `stripsHeaders` says whether the framing rule is in force. Returns null when
 * the page should simply be framed at its own address.
 */
export function previewFor(url: string, stripsHeaders: boolean): Preview | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const vimeo = /^(?:www\.)?vimeo\.com$/.test(parsed.hostname)
    ? /^\/(\d+)/.exec(parsed.pathname)
    : null;
  if (vimeo) {
    return {
      kind: "frame",
      url: `https://player.vimeo.com/video/${vimeo[1]}`,
      note: "Showing the Vimeo player.",
    };
  }

  const video = stripsHeaders ? null : youtubeId(parsed);
  if (video) {
    return {
      kind: "image",
      // maxresdefault is the 16:9 original and exists for most uploads;
      // hqdefault exists for every video.
      url: `https://i.ytimg.com/vi/${video}/maxresdefault.jpg`,
      fallback: `https://i.ytimg.com/vi/${video}/hqdefault.jpg`,
      note: "Showing the video's thumbnail, since live previews are unavailable.",
    };
  }

  return null;
}
