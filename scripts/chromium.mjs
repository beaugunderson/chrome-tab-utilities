// The Chromium the verify scripts drive. System Chrome cannot load an unpacked
// MV3 extension headless, so this is a Chrome for Testing build from the
// Playwright cache: CHROME_FOR_TESTING if set, otherwise the newest cached one.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

export function chromiumPath() {
  if (process.env.CHROME_FOR_TESTING) return process.env.CHROME_FOR_TESTING;
  const cache = join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  const builds = readdirSync(cache)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((match) => join(cache, match[0], APP))
    .filter((path) => existsSync(path));
  if (builds.length === 0) {
    throw new Error(
      `no Chromium in ${cache}; run \`pnpm exec playwright install chromium\` or set CHROME_FOR_TESTING`,
    );
  }
  return builds[0];
}
