// Whether you ever went back to a tab.
//
// Measured on a real 642-tab set: 548 of them (85%) were opened exactly once
// and never returned to, while the 94 with any repeat visit turned out to be
// the working set — mail, calendar, a paper being reread. Topic says nothing
// about which of those a tab is, and topic is what the clustering knows. This
// is the one axis in the data that separates "the pile" from "the tools".

/** Repeat visits below this and a tab was a drive-by open. */
const RETURNED_THRESHOLD = 2;

export interface Engagement {
  visits: number;
  returned: boolean;
}

export function classifyVisits(visits: number): Engagement {
  return { visits, returned: visits >= RETURNED_THRESHOLD };
}

/**
 * How a tab's history reads in one line, which is most of what a decision
 * needs: something opened once a month ago and never reopened is a different
 * proposition from something opened weekly.
 */
export function describeEngagement(visits: number, idleDays: number): string {
  const age =
    idleDays >= 900
      ? "at some point"
      : idleDays < 1
        ? "today"
        : `${Math.round(idleDays)}d ago`;
  if (visits <= 1) return `opened once ${age}, never returned`;
  return `returned ${visits}×, last ${age}`;
}

/**
 * Visit counts for each URL, straight from browsing history.
 *
 * getVisits is an exact-URL lookup; history.search does substring matching and
 * would credit one tab with another's visits. The calls are local and cheap,
 * so a few hundred of them cost little.
 */
export async function fetchVisitCounts(
  urls: string[],
  concurrency = 24,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let next = 0;

  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const visits = await chrome.history.getVisits({ url });
        counts.set(url, visits.length);
      } catch {
        // Not in history, or not a URL history keeps. Treat as a drive-by.
        counts.set(url, 0);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker),
  );
  return counts;
}
