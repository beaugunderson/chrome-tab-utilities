import { describe, expect, it } from "vitest";
import {
  type ClusterInput,
  type Merge,
  cutTree,
  distanceMatrix,
  heightRange,
  linkage,
  nearDuplicatePairs,
  sortedHeights,
  subCut,
  subCutThreshold,
  subtreeHeights,
} from "./cluster";

/** Unit-length vector on the unit circle, so distances are hand-checkable. */
function onCircle(degrees: number): Float32Array {
  const radians = (degrees * Math.PI) / 180;
  return new Float32Array([Math.cos(radians), Math.sin(radians)]);
}

function plain(vec: Float32Array): ClusterInput {
  return { vec, domain: null, openerRoot: null, groupId: null };
}

/** Reference implementation: repeatedly merge the globally closest pair. */
function naiveLinkage(condensed: Float32Array, n: number): Merge[] {
  const index = (i: number, j: number) => {
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    return lo * n - (lo * (lo + 1)) / 2 + (hi - lo - 1);
  };
  const d = Float32Array.from(condensed);
  const active = Array.from({ length: n }, (_, i) => i);
  const sizes = new Array<number>(n).fill(1);
  const nodeId = Array.from({ length: n }, (_, i) => i);
  const merges: Merge[] = [];

  while (active.length > 1) {
    let bestI = -1;
    let bestJ = -1;
    let best = Infinity;
    for (let x = 0; x < active.length; x++) {
      for (let y = x + 1; y < active.length; y++) {
        const candidate = d[index(active[x], active[y])];
        if (candidate < best) {
          best = candidate;
          bestI = active[x];
          bestJ = active[y];
        }
      }
    }
    const keep = Math.min(bestI, bestJ);
    const drop = Math.max(bestI, bestJ);
    const total = sizes[keep] + sizes[drop];
    for (const other of active) {
      if (other === keep || other === drop) continue;
      d[index(keep, other)] =
        (sizes[keep] * d[index(keep, other)] +
          sizes[drop] * d[index(drop, other)]) /
        total;
    }
    merges.push({ a: nodeId[keep], b: nodeId[drop], distance: best, size: total });
    nodeId[keep] = n + merges.length - 1;
    sizes[keep] = total;
    active.splice(active.indexOf(drop), 1);
  }
  return merges;
}

describe("distanceMatrix", () => {
  it("gives cosine distance for plain items", () => {
    const items = [plain(onCircle(0)), plain(onCircle(90))];
    // Perpendicular unit vectors: dot 0, so distance 1.
    expect(distanceMatrix(items)[0]).toBeCloseTo(1, 5);
  });

  it("never reports a negative distance for opposed vectors", () => {
    const items = [plain(onCircle(0)), plain(onCircle(180))];
    // Raw 1 - dot would be 2 here; the clamp only guards the other end.
    expect(distanceMatrix(items)[0]).toBeCloseTo(2, 5);
  });

  it("compounds structural factors multiplicatively", () => {
    const a = onCircle(0);
    const b = onCircle(90);
    const base = distanceMatrix([plain(a), plain(b)])[0];

    const sameDomain = distanceMatrix([
      { vec: a, domain: "github", openerRoot: null, groupId: null },
      { vec: b, domain: "github", openerRoot: null, groupId: null },
    ])[0];
    expect(sameDomain).toBeCloseTo(base * 0.85, 5);

    const both = distanceMatrix([
      { vec: a, domain: "github", openerRoot: "x", groupId: null },
      { vec: b, domain: "github", openerRoot: "x", groupId: null },
    ])[0];
    expect(both).toBeCloseTo(base * 0.85 * 0.6, 5);
  });

  it("ignores a shared null domain", () => {
    const items = [plain(onCircle(0)), plain(onCircle(90))];
    expect(distanceMatrix(items)[0]).toBeCloseTo(1, 5);
  });
});

describe("linkage", () => {
  // Two tight pairs far apart, plus one outlier that joins last.
  const angles = [0, 5, 100, 105, 200];
  const items = angles.map((a) => plain(onCircle(a)));

  it("merges the closest pair first and the outlier last", () => {
    const merges = linkage(distanceMatrix(items), items.length);
    expect(merges).toHaveLength(4);
    // Leaves 0 and 1 are 5 degrees apart, the tightest pair in the set.
    expect([merges[0].a, merges[0].b].sort()).toEqual([0, 1]);
    expect([merges[1].a, merges[1].b].sort()).toEqual([2, 3]);
    // Leaf 4 survives to the final merge.
    expect(merges[3].size).toBe(5);
  });

  it("builds a tree with no inversions", () => {
    // Reducibility guarantees a parent never merges below its children, which
    // is what lets the granularity slider behave monotonically. Note this is a
    // claim about the tree, not about emission order: NN-chain discovers
    // merges out of distance order by design.
    const merges = linkage(distanceMatrix(items), items.length);
    const n = items.length;
    for (let i = 0; i < merges.length; i++) {
      for (const child of [merges[i].a, merges[i].b]) {
        if (child < n) continue;
        expect(merges[i].distance).toBeGreaterThanOrEqual(
          merges[child - n].distance - 1e-6,
        );
      }
    }
  });

  it("matches a naive greedy implementation, including on non-metric input", () => {
    // Structural factors break the triangle inequality on purpose; NN-chain
    // must still reproduce the same greedy dendrogram. Compared as a set of
    // (leaf set, height) merges, since the discovery order legitimately
    // differs from the naive globally-closest-pair order.
    const nonMetric: ClusterInput[] = [
      { vec: onCircle(0), domain: "a", openerRoot: null, groupId: null },
      { vec: onCircle(80), domain: "a", openerRoot: "r", groupId: 1 },
      { vec: onCircle(85), domain: "b", openerRoot: null, groupId: null },
      { vec: onCircle(170), domain: "b", openerRoot: "r", groupId: 1 },
      { vec: onCircle(250), domain: "a", openerRoot: null, groupId: 1 },
      { vec: onCircle(300), domain: "c", openerRoot: null, groupId: null },
    ];
    const n = nonMetric.length;
    const condensed = distanceMatrix(nonMetric);

    const canonical = (merges: Merge[]) => {
      const members: number[][] = [];
      for (let i = 0; i < n; i++) members.push([i]);
      const rows: string[] = [];
      for (const m of merges) {
        const leaves = members[m.a].concat(members[m.b]);
        members.push(leaves);
        rows.push(
          `${[...leaves].sort((x, y) => x - y).join(",")}@${m.distance.toFixed(5)}`,
        );
      }
      return rows.sort();
    };

    expect(canonical(linkage(condensed, n))).toEqual(
      canonical(naiveLinkage(condensed, n)),
    );
  });

  it("returns nothing for fewer than two items", () => {
    expect(linkage(new Float32Array(0), 1)).toEqual([]);
    expect(linkage(new Float32Array(0), 0)).toEqual([]);
  });
});

describe("cutTree", () => {
  const angles = [0, 5, 100, 105, 200];
  const items = angles.map((a) => plain(onCircle(a)));
  const n = items.length;
  const merges = linkage(distanceMatrix(items), n);

  it("returns every leaf exactly once at any threshold", () => {
    for (const threshold of [0, 0.05, 0.3, 0.9, 1.5, 3]) {
      const leaves = cutTree(merges, n, threshold).flatMap((c) => c.leaves);
      expect(leaves.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("splits into all singletons below the lowest merge", () => {
    expect(cutTree(merges, n, -1)).toHaveLength(5);
  });

  it("collapses to one cluster above the highest merge", () => {
    expect(cutTree(merges, n, 10)).toHaveLength(1);
  });

  it("never increases cluster count as the threshold rises", () => {
    let previous = Infinity;
    for (let t = 0; t <= 2; t += 0.05) {
      const count = cutTree(merges, n, t).length;
      expect(count).toBeLessThanOrEqual(previous);
      previous = count;
    }
  });

  it("recovers the two tight pairs at an intermediate threshold", () => {
    const clusters = cutTree(merges, n, 0.02);
    const pairs = clusters
      .filter((c) => c.leaves.length === 2)
      .map((c) => [...c.leaves].sort());
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([2, 3]);
  });

  it("sorts clusters largest first", () => {
    const sizes = cutTree(merges, n, 0.5).map((c) => c.leaves.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("handles a single item", () => {
    expect(cutTree([], 1, 0.5)).toEqual([{ node: 0, leaves: [0], height: 0 }]);
  });

  it("handles an empty set", () => {
    expect(cutTree([], 0, 0.5)).toEqual([]);
  });
});

describe("subCut", () => {
  // One broad topic containing two sub-topics, plus a distant tab.
  const angles = [0, 2, 40, 42, 250];
  const items = angles.map((a) => plain(onCircle(a)));
  const n = items.length;
  const merges = linkage(distanceMatrix(items), n);

  it("splits a broad cluster into its sub-clusters", () => {
    const broad = cutTree(merges, n, 0.5).find((c) => c.leaves.length === 4);
    expect(broad).toBeDefined();

    const subs = subCut(merges, n, broad!.node, 0.01);
    expect(subs).not.toBeNull();
    const pairs = subs!.map((c) => [...c.leaves].sort());
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([2, 3]);
  });

  it("keeps every leaf of the parent and adds none", () => {
    const broad = cutTree(merges, n, 0.5).find((c) => c.leaves.length === 4)!;
    const subs = subCut(merges, n, broad.node, 0.01)!;
    expect(subs.flatMap((c) => c.leaves).sort()).toEqual([0, 1, 2, 3]);
  });

  it("returns null for a leaf", () => {
    expect(subCut(merges, n, 0, 0.01)).toBeNull();
  });

  it("returns null when the threshold reveals no split", () => {
    const broad = cutTree(merges, n, 0.5).find((c) => c.leaves.length === 4)!;
    expect(subCut(merges, n, broad.node, 10)).toBeNull();
  });
});

describe("subtreeHeights and subCutThreshold", () => {
  const angles = [0, 2, 40, 42, 250];
  const items = angles.map((a) => plain(onCircle(a)));
  const n = items.length;
  const merges = linkage(distanceMatrix(items), n);
  const broad = cutTree(merges, n, 0.5).find((c) => c.leaves.length === 4)!;

  it("excludes the node's own height", () => {
    const heights = subtreeHeights(merges, n, broad.node);
    expect(heights).toHaveLength(2);
    for (const h of heights) expect(h).toBeLessThan(broad.height);
  });

  it("returns ascending heights", () => {
    const heights = subtreeHeights(merges, n, broad.node);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
  });

  it("is empty for a leaf", () => {
    expect(subtreeHeights(merges, n, 0)).toEqual([]);
    expect(subCutThreshold(merges, n, 0, 0.5)).toBe(0);
  });

  it("yields a threshold that actually splits the subtree", () => {
    const threshold = subCutThreshold(merges, n, broad.node, 0.6);
    expect(subCut(merges, n, broad.node, threshold)).not.toBeNull();
  });
});

describe("sortedHeights", () => {
  it("returns every merge height in ascending order", () => {
    const items = [0, 5, 100, 200].map((a) => plain(onCircle(a)));
    const merges = linkage(distanceMatrix(items), items.length);
    const heights = sortedHeights(merges);
    expect(heights).toHaveLength(merges.length);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
  });
});

describe("heightRange", () => {
  it("spans the lowest and highest merge", () => {
    const items = [0, 5, 100].map((a) => plain(onCircle(a)));
    const merges = linkage(distanceMatrix(items), items.length);
    const { min, max } = heightRange(merges);
    expect(min).toBeCloseTo(merges[0].distance, 5);
    expect(max).toBeCloseTo(merges[merges.length - 1].distance, 5);
  });

  it("falls back to a usable range with no merges", () => {
    expect(heightRange([])).toEqual({ min: 0, max: 1 });
  });
});

describe("nearDuplicatePairs", () => {
  it("finds only pairs above the similarity threshold", () => {
    const items = [onCircle(0), onCircle(1), onCircle(90)].map(plain);
    expect(nearDuplicatePairs(items, 0.95)).toEqual([[0, 1]]);
  });

  it("ignores structural factors, matching on text alone", () => {
    // Same domain, unrelated content: emphatically not a duplicate.
    const items: ClusterInput[] = [
      { vec: onCircle(0), domain: "github", openerRoot: null, groupId: null },
      { vec: onCircle(90), domain: "github", openerRoot: null, groupId: null },
    ];
    expect(nearDuplicatePairs(items, 0.95)).toEqual([]);
  });
});
