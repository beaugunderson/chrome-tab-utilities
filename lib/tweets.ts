// Reading x.com posts without loading x.com.
//
// Measured on 53 real tabs: x.com serves a JS shell whose only meta tags are
// viewport, fb:app_id, og:site_name and three site-verification tokens. No
// title, no description, nothing per-post. The app never hydrates in a
// background tab, so document.title stays empty however long you wait, and
// there is genuinely nothing in the page to read.
//
// Twitter's syndication endpoint returns the post text as JSON, unauthenticated
// and without rendering anything. It is one request instead of one page load,
// so it is also far cheaper than the harvest it replaces.

const ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";
const TWEET_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

export interface Tweet {
  text: string;
  author?: string;
  handle?: string;
}

/** The post id in an x.com or twitter.com status URL, if it is one. */
export function tweetIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!TWEET_HOSTS.has(parsed.hostname.replace(/^www\./, ""))) return null;
  // /<handle>/status/<id>, sometimes with a trailing /photo/1 or /video/1.
  const match = /^\/[^/]+\/status(?:es)?\/(\d+)/.exec(parsed.pathname);
  return match ? match[1] : null;
}

/** Handle from an x.com URL, which is real information even when nothing loads. */
export function tweetHandleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!TWEET_HOSTS.has(parsed.hostname.replace(/^www\./, ""))) return null;
    const first = parsed.pathname.split("/").filter(Boolean)[0];
    return first && first !== "i" ? first : null;
  } catch {
    return null;
  }
}

export async function fetchTweet(id: string): Promise<Tweet | null> {
  const url = `${ENDPOINT}?id=${encodeURIComponent(id)}&token=a&lang=en`;
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      text?: string;
      user?: { name?: string; screen_name?: string };
    };
    const text = data.text?.trim();
    if (!text) return null;
    return {
      text,
      author: data.user?.name,
      handle: data.user?.screen_name,
    };
  } catch {
    // Deleted, protected, or the endpoint refused. Nothing to recover.
    return null;
  }
}
