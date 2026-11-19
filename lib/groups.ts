export type GroupColor = `${chrome.tabGroups.Color}`;

export const GROUP_COLOR_NAMES: readonly GroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

/**
 * The color a domain's group always gets, so every window's GITHUB looks the
 * same. Chrome picks a color per group when none is given, which leaves
 * same-named groups in different colors and the color meaning nothing.
 */
export function colorForDomain(key: string): GroupColor {
  // FNV-1a over the uppercased key; group titles are matched without case.
  let hash = 0x811c9dc5;
  for (const ch of key.toUpperCase()) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return GROUP_COLOR_NAMES[(hash >>> 0) % GROUP_COLOR_NAMES.length];
}

export type TargetGroup = { id: number; title?: string };
export type SourceGroup = {
  title?: string;
  color?: GroupColor;
  tabIds: number[];
};
export type GroupMergePlan = {
  /** Tabs to add to a group the target window already has. */
  joins: { groupId: number; tabIds: number[] }[];
  /** Groups to create in the target window. */
  creates: SourceGroup[];
};

/**
 * Decide where each incoming group's tabs go when windows merge. Groups
 * sharing a title become one group: the target window's if it has one,
 * otherwise a single new group taking the first source's color. Untitled
 * groups stay separate, since nothing says two of them are the same thing.
 */
export function planGroupMerge(
  targetGroups: TargetGroup[],
  sourceGroups: SourceGroup[],
): GroupMergePlan {
  const joins = new Map<string, { groupId: number; tabIds: number[] }>();
  for (const g of targetGroups) {
    const key = titleKey(g.title);
    if (key && !joins.has(key)) joins.set(key, { groupId: g.id, tabIds: [] });
  }

  const titled = new Map<string, SourceGroup>();
  const creates: SourceGroup[] = [];
  for (const g of sourceGroups) {
    const key = titleKey(g.title);
    if (!key) {
      creates.push({ ...g, tabIds: [...g.tabIds] });
      continue;
    }
    const join = joins.get(key);
    if (join) {
      join.tabIds.push(...g.tabIds);
      continue;
    }
    const pending = titled.get(key);
    if (pending) {
      pending.tabIds.push(...g.tabIds);
      continue;
    }
    const created = { ...g, tabIds: [...g.tabIds] };
    titled.set(key, created);
    creates.push(created);
  }

  return {
    joins: Array.from(joins.values()).filter((j) => j.tabIds.length > 0),
    creates,
  };
}

function titleKey(title: string | undefined): string {
  return (title ?? "").trim().toUpperCase();
}
