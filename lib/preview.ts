// What to show for a page that will not frame at its own address.
//
// Two shapes come out of this. Some sites publish a second address built to be
// framed, and pointing the frame at that one beats stripping headers off the
// first: Vimeo's player embeds cleanly from an extension page. YouTube's does
// not — its player refuses any embedder whose origin is not http(s), so a
// chrome-extension:// page always gets "Error 153", whatever the iframe's
// attributes or origin parameter say. Measured against www.youtube.com,
// www.youtube-nocookie.com, with and without sandbox, referrerpolicy and
// origin=, on two videos: all eight combinations fail identically, while the
// same embed from http://localhost does not. So YouTube gets a still frame,
// which is enough to decide from and needs no framing at all.

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
 * Returns null when the page should simply be framed as-is.
 */
export function previewFor(url: string): Preview | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const video = youtubeId(parsed);
  if (video) {
    return {
      kind: "image",
      // maxresdefault is the 16:9 original and exists for most uploads;
      // hqdefault exists for every video.
      url: `https://i.ytimg.com/vi/${video}/maxresdefault.jpg`,
      fallback: `https://i.ytimg.com/vi/${video}/hqdefault.jpg`,
      note: "Showing the video's thumbnail; YouTube's player runs only inside a web page.",
    };
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

  return null;
}
