import { describe, expect, it } from "vitest";
import { classifyVisits, countVisitDays, describeEngagement } from "./engagement";

const DAY = 24 * 60 * 60 * 1000;
const base = Date.parse("2026-06-01T09:00:00Z");
const days = (...offsets: number[]) => offsets.map((d) => base + d * DAY);

describe("countVisitDays", () => {
  it("treats one day of visits as never returned, however many there were", () => {
    // The failure this replaces: a single night of mass reloads read as
    // twenty returns, and 96% of a real tab set landed in the working set.
    const storm = Array.from({ length: 20 }, (_, i) => base + i * 60_000);
    expect(countVisitDays(storm).returned).toBe(false);
    expect(countVisitDays(storm).days).toBe(1);
    expect(countVisitDays(storm).visits).toBe(20);
  });

  it("counts a tab returned to on separate days", () => {
    expect(countVisitDays(days(0, 4, 11)).returned).toBe(true);
    expect(countVisitDays(days(0, 4)).returned).toBe(false);
  });

  it("discounts loads that happened during a triage sweep", () => {
    // Reading a tab's text loads it, and a load is a visit. Left in, the page
    // reports that you keep going back to every tab it just read.
    const sweeps = days(4, 11, 18);
    expect(countVisitDays(days(0, 4, 11, 18), sweeps).days).toBe(1);
    expect(countVisitDays(days(0, 4, 11, 18), sweeps).returned).toBe(false);
  });

  it("keeps the first visit even when a sweep was running", () => {
    // Otherwise a tab opened while triaging looks like it was never opened.
    expect(countVisitDays(days(0), days(0)).days).toBe(1);
  });

  it("keeps real returns that fall outside any sweep", () => {
    expect(countVisitDays(days(0, 4, 9, 11), days(4, 11)).days).toBe(2);
  });

  it("has no engagement for a URL history has never seen", () => {
    expect(countVisitDays([]).returned).toBe(false);
    expect(countVisitDays([]).days).toBe(0);
  });
});

describe("describeEngagement", () => {
  it("says plainly that a tab was never returned to", () => {
    expect(describeEngagement(classifyVisits(1), 44)).toBe(
      "opened 44d ago, never came back",
    );
  });

  it("counts the days when there were any", () => {
    expect(describeEngagement(classifyVisits(6), 3)).toBe(
      "came back on 6 days, last 3d ago",
    );
  });

  it("reads naturally for today and for unknown ages", () => {
    expect(describeEngagement(classifyVisits(1), 0.2)).toContain("today");
    expect(describeEngagement(classifyVisits(1), 999)).toContain("at some point");
  });
});
