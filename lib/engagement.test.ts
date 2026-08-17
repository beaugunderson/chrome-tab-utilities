import { describe, expect, it } from "vitest";
import { classifyVisits, describeEngagement } from "./engagement";

describe("classifyVisits", () => {
  it("treats a single visit as never returned", () => {
    // 85% of a real tab set. These are the pile.
    expect(classifyVisits(1).returned).toBe(false);
    expect(classifyVisits(0).returned).toBe(false);
  });

  it("treats any repeat visit as returned", () => {
    // The 15% that turned out to be mail, calendar and things being reread.
    expect(classifyVisits(2).returned).toBe(true);
    expect(classifyVisits(1137).returned).toBe(true);
  });
});

describe("describeEngagement", () => {
  it("says plainly that a tab was never returned to", () => {
    expect(describeEngagement(1, 44)).toBe("opened once 44d ago, never returned");
  });

  it("counts the returns when there were any", () => {
    expect(describeEngagement(6, 3)).toBe("returned 6×, last 3d ago");
  });

  it("reads naturally for today and for unknown ages", () => {
    expect(describeEngagement(1, 0.2)).toContain("today");
    expect(describeEngagement(1, 999)).toContain("at some point");
  });
});
