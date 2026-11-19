import { describe, expect, it } from "vitest";
import { GROUP_COLOR_NAMES, colorForDomain, planGroupMerge } from "./groups";

describe("colorForDomain", () => {
  it("gives a domain the same color every time", () => {
    expect(colorForDomain("GITHUB")).toBe(colorForDomain("GITHUB"));
  });

  it("ignores case, since group titles are matched without it", () => {
    expect(colorForDomain("github")).toBe(colorForDomain("GITHUB"));
  });

  it("only returns colors Chrome accepts", () => {
    for (const key of ["GITHUB", "NOTION", "GOOGLE", "ATLASSIAN", "localhost"]) {
      expect(GROUP_COLOR_NAMES).toContain(colorForDomain(key));
    }
  });

  it("spreads domains across the palette", () => {
    const used = new Set(
      Array.from({ length: 200 }, (_, i) => colorForDomain(`DOMAIN${i}`)),
    );
    expect(used.size).toBe(GROUP_COLOR_NAMES.length);
  });
});

describe("planGroupMerge", () => {
  it("joins a source group to the target window's group of the same title", () => {
    const plan = planGroupMerge(
      [{ id: 10, title: "GITHUB" }],
      [{ title: "GITHUB", color: "red", tabIds: [1, 2] }],
    );
    expect(plan.joins).toEqual([{ groupId: 10, tabIds: [1, 2] }]);
    expect(plan.creates).toEqual([]);
  });

  it("folds same-titled source groups from different windows into one new group", () => {
    const plan = planGroupMerge(
      [],
      [
        { title: "NOTION", color: "blue", tabIds: [1, 2] },
        { title: "NOTION", color: "grey", tabIds: [3] },
      ],
    );
    expect(plan.joins).toEqual([]);
    expect(plan.creates).toEqual([
      { title: "NOTION", color: "blue", tabIds: [1, 2, 3] },
    ]);
  });

  it("matches titles without regard to case", () => {
    const plan = planGroupMerge(
      [{ id: 10, title: "Reading" }],
      [{ title: "reading", color: "pink", tabIds: [4] }],
    );
    expect(plan.joins).toEqual([{ groupId: 10, tabIds: [4] }]);
  });

  it("keeps untitled groups apart, since no title says they are the same thing", () => {
    const plan = planGroupMerge(
      [{ id: 10, title: "" }],
      [
        { title: "", color: "blue", tabIds: [1] },
        { title: undefined, color: "red", tabIds: [2] },
      ],
    );
    expect(plan.joins).toEqual([]);
    expect(plan.creates).toEqual([
      { title: "", color: "blue", tabIds: [1] },
      { title: undefined, color: "red", tabIds: [2] },
    ]);
  });

  it("sends every same-titled source group to one target group", () => {
    const plan = planGroupMerge(
      [{ id: 10, title: "GITHUB" }],
      [
        { title: "GITHUB", color: "red", tabIds: [1] },
        { title: "GITHUB", color: "blue", tabIds: [2, 3] },
      ],
    );
    expect(plan.joins).toEqual([{ groupId: 10, tabIds: [1, 2, 3] }]);
  });
});
