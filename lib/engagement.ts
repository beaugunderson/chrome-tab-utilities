// Whether you ever went back to a tab.
//
// The signal is the number of distinct days a URL was visited on, not the
// number of visits. A visit count cannot tell a tab you live in from one that
// was loaded twenty times by one bad night: measured on a real 754-tab set,
// 726 of them (96%) had two or more visits, and the top of that list was
// hundreds of x.com posts read once. Counting days instead puts 111 tabs (15%)
// above four days, and that list is the working set exactly — mail, calendar,
// LinkedIn, Drive, a trip being planned, a PR, a post being reread.
//
// A mass reload is one day however many tabs it touches, so a crash or a
// restore costs a tab one day rather than twenty visits, which is what makes
// this hold up where a count does not.

/** Distinct days below this and a tab was a drive-by open. */
const RETURNED_DAYS = 3;

/** How far either side of a sweep its loads are assumed to reach. */
const SWEEP_WINDOW_MS = 20 * 60 * 1000;

export interface Engagement {
  /** Distinct days this URL was visited on, sweeps discounted. */
  days: number;
  visits: number;
  returned: boolean;
}

export function classifyVisits(days: number, visits = days): Engagement {
  return { days, visits, returned: days >= RETURNED_DAYS };
}

/**
 * How a tab's history reads in one line, which is most of what a decision
 * needs: something opened once a month ago and never reopened is a different
 * proposition from something opened on nine separate days.
 */
export function describeEngagement(engagement: Engagement, idleDays: number): string {
  const age =
    idleDays >= 900
      ? "at some point"
      : idleDays < 1
        ? "today"
        : `${Math.round(idleDays)}d ago`;
  if (engagement.days <= 1) return `opened ${age}, never came back`;
  return `came back on ${engagement.days} days, last ${age}`;
}

/**
 * Days on which each URL was visited, ignoring this page's own sweeps.
 *
 * Reading a tab's page text means loading it, and a load is a visit, so a
 * harvest writes one visit for every tab it touches. Left in, that is a
 * feedback loop: the page reloads 700 tabs, reads the visits back, and reports
 * that you keep going back to all of them. The triage page's own visits are in
 * history too, so its sessions can be found and the loads around them dropped.
 */
export function countVisitDays(
  visitTimes: number[],
  sweepTimes: number[] = [],
): Engagement {
  const ordered = [...visitTimes].sort((a, b) => a - b);
  const days = new Set<string>();
  for (const [index, time] of ordered.entries()) {
    // The first visit is what opened the tab, and is never a sweep.
    if (index > 0 && sweepTimes.some((s) => Math.abs(s - time) <= SWEEP_WINDOW_MS)) {
      continue;
    }
    days.add(new Date(time).toDateString());
  }
  return classifyVisits(days.size, ordered.length);
}

/** When the triage page itself was open, taken from its own history. */
export async function fetchSweepTimes(): Promise<number[]> {
  try {
    const url = chrome.runtime.getURL("triage.html");
    const visits = await chrome.history.getVisits({ url });
    return visits.map((visit) => visit.visitTime ?? 0).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Engagement for each URL, straight from browsing history.
 *
 * getVisits is an exact-URL lookup; history.search does substring matching and
 * would credit one tab with another's visits. The calls are local and cheap,
 * so a few hundred of them cost little.
 */
export async function fetchEngagement(
  urls: string[],
  sweepTimes: number[] = [],
  concurrency = 24,
): Promise<Map<string, Engagement>> {
  const engagement = new Map<string, Engagement>();
  let next = 0;

  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const visits = await chrome.history.getVisits({ url });
        engagement.set(
          url,
          countVisitDays(
            visits.map((visit) => visit.visitTime ?? 0).filter(Boolean),
            sweepTimes,
          ),
        );
      } catch {
        // Not in history, or not a URL history keeps. Treat as a drive-by.
        engagement.set(url, classifyVisits(0, 0));
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker),
  );
  return engagement;
}
