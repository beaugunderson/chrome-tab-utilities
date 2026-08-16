// Average-linkage agglomerative clustering over unit-length embeddings.
//
// Produces a merge history (a dendrogram) once, which the UI then slices at
// whatever granularity the slider is set to. Slicing is a tree walk, so
// dragging the slider never re-clusters.

// Structural signals the text embedding can't see. Each shrinks the distance
// between a pair multiplicatively, so several agreeing signals compound.
const SHARED_OPENER_FACTOR = 0.6;
const SAME_GROUP_FACTOR = 0.7;
const SAME_DOMAIN_FACTOR = 0.85;

export interface ClusterInput {
  /** Unit-length embedding. Cosine similarity is therefore a plain dot product. */
  vec: Float32Array;
  domain: string | null;
  /** Root of this tab's opener chain, so a whole branch shares one value. */
  openerRoot: string | null;
  /** Existing Chrome tab group id, or null when ungrouped. */
  groupId: number | null;
}

export interface Merge {
  /** Node ids being joined. Ids < n are leaves; n + i is the i-th merge. */
  a: number;
  b: number;
  distance: number;
  size: number;
}

/** A slice of the dendrogram: one subtree, flattened to its leaves. */
export interface CutCluster {
  /** Node id of the subtree root, which subCut() needs to drill in further. */
  node: number;
  leaves: number[];
  /** Distance at which this subtree's last merge happened; 0 for a leaf. */
  height: number;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Condensed pairwise distance matrix, upper triangle only, row-major.
 */
export function distanceMatrix(items: ClusterInput[]): Float32Array {
  const n = items.length;
  const out = new Float32Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const a = items[i];
    for (let j = i + 1; j < n; j++) {
      const b = items[j];
      let d = 1 - dot(a.vec, b.vec);
      if (d < 0) d = 0;
      if (a.openerRoot !== null && a.openerRoot === b.openerRoot) {
        d *= SHARED_OPENER_FACTOR;
      }
      if (a.groupId !== null && a.groupId === b.groupId) d *= SAME_GROUP_FACTOR;
      if (a.domain !== null && a.domain === b.domain) d *= SAME_DOMAIN_FACTOR;
      out[k++] = d;
    }
  }
  return out;
}

function condensedIndex(n: number, i: number, j: number): number {
  const lo = i < j ? i : j;
  const hi = i < j ? j : i;
  return lo * n - (lo * (lo + 1)) / 2 + (hi - lo - 1);
}

/**
 * Nearest-neighbor-chain agglomerative clustering with average linkage.
 *
 * NN-chain yields exactly the greedy dendrogram whenever the linkage is
 * reducible, and average linkage is reducible for *any* symmetric non-negative
 * input, not just a metric: the Lance-Williams update makes the merged
 * cluster's distance a weighted average of the two it replaces, and a weighted
 * average of two values that both exceed d(i,j) also exceeds d(i,j). That
 * matters here because the structural factors above deliberately break the
 * triangle inequality.
 *
 * Returns n - 1 merges in the order they occurred. Merge i creates node n + i.
 */
export function linkage(condensed: Float32Array, n: number): Merge[] {
  if (n < 2) return [];

  // Active clusters, tracked by their original slot in the distance matrix.
  const active: number[] = [];
  for (let i = 0; i < n; i++) active.push(i);
  const sizes = new Int32Array(n).fill(1);
  // Dendrogram node each slot currently stands for; starts as the leaf id.
  const nodeId = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeId[i] = i;

  // Mutable copy: merges rewrite distances in place via Lance-Williams.
  const d = Float32Array.from(condensed);
  const dist = (i: number, j: number) => d[condensedIndex(n, i, j)];

  const merges: Merge[] = [];
  const chain: number[] = [];

  const merge = (i: number, j: number, distance: number) => {
    // Keep the lower slot, retire the higher one.
    const keep = i < j ? i : j;
    const drop = i < j ? j : i;
    const sizeKeep = sizes[keep];
    const sizeDrop = sizes[drop];
    const total = sizeKeep + sizeDrop;

    for (const other of active) {
      if (other === keep || other === drop) continue;
      d[condensedIndex(n, keep, other)] =
        (sizeKeep * dist(keep, other) + sizeDrop * dist(drop, other)) / total;
    }

    merges.push({ a: nodeId[keep], b: nodeId[drop], distance, size: total });
    nodeId[keep] = n + merges.length - 1;
    sizes[keep] = total;
    active.splice(active.indexOf(drop), 1);
  };

  while (active.length > 1) {
    if (chain.length === 0) chain.push(active[0]);

    // Extend the chain until two clusters are each other's nearest neighbor.
    for (;;) {
      const current = chain[chain.length - 1];
      const previous = chain.length > 1 ? chain[chain.length - 2] : -1;

      let best = -1;
      let bestDistance = Infinity;
      for (const candidate of active) {
        if (candidate === current) continue;
        const candidateDistance = dist(current, candidate);
        // Ties resolve toward where we came from, which is what terminates the
        // chain instead of cycling between equidistant pairs.
        if (
          candidateDistance < bestDistance ||
          (candidateDistance === bestDistance && candidate === previous)
        ) {
          bestDistance = candidateDistance;
          best = candidate;
        }
      }

      if (best === previous) {
        chain.pop();
        chain.pop();
        merge(current, best, bestDistance);
        break;
      }
      chain.push(best);
    }
  }

  return merges;
}

/**
 * Leaves under every dendrogram node, indexed by node id. Build this once per
 * render and hand it to cutTree/subCut: with every cluster expanded there is
 * one subCut call per visible cluster, and recomputing it in each would walk
 * the whole tree dozens of times.
 */
export function collectMembers(merges: Merge[], n: number): number[][] {
  const members: number[][] = [];
  for (let i = 0; i < n; i++) members.push([i]);
  for (const { a, b } of merges) members.push(members[a].concat(members[b]));
  return members;
}

function heightOf(merges: Merge[], n: number, node: number): number {
  return node < n ? 0 : merges[node - n].distance;
}

/**
 * Walk down from `root`, emitting a cluster as soon as a subtree's own merge
 * height falls at or below `threshold`. Descending rather than absorbing
 * bottom-up guarantees the result is a partition regardless of tree shape.
 */
function descend(
  merges: Merge[],
  n: number,
  members: number[][],
  root: number,
  threshold: number,
  out: CutCluster[],
) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const height = heightOf(merges, n, node);
    if (node < n || height <= threshold) {
      out.push({ node, leaves: members[node], height });
      continue;
    }
    const { a, b } = merges[node - n];
    stack.push(a, b);
  }
}

/**
 * Slice the whole dendrogram at `threshold`, largest cluster first.
 */
export function cutTree(
  merges: Merge[],
  n: number,
  threshold: number,
  precomputed?: number[][],
): CutCluster[] {
  if (n === 0) return [];
  if (merges.length === 0) {
    return [{ node: 0, leaves: [0], height: 0 }];
  }
  const members = precomputed ?? collectMembers(merges, n);
  const out: CutCluster[] = [];
  descend(merges, n, members, n + merges.length - 1, threshold, out);
  return out.sort((x, y) => y.leaves.length - x.leaves.length);
}

/**
 * Re-slice one cluster's own subtree at a tighter threshold, which is how
 * "news" opens into per-event sub-clusters. Returns null when the subtree has
 * no internal structure left to reveal at that threshold.
 */
export function subCut(
  merges: Merge[],
  n: number,
  node: number,
  threshold: number,
  precomputed?: number[][],
): CutCluster[] | null {
  if (node < n) return null;
  const members = precomputed ?? collectMembers(merges, n);
  const out: CutCluster[] = [];
  descend(merges, n, members, node, threshold, out);
  if (out.length < 2) return null;
  return out.sort((x, y) => y.leaves.length - x.leaves.length);
}

/**
 * The range of merge heights in the tree, which is what the granularity slider
 * maps its 0..1 position onto. Clustering on a fixed absolute threshold would
 * behave differently for every tab set.
 */
export function heightRange(merges: Merge[]): { min: number; max: number } {
  if (merges.length === 0) return { min: 0, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const m of merges) {
    if (m.distance < min) min = m.distance;
    if (m.distance > max) max = m.distance;
  }
  return { min, max };
}

/** Merge heights strictly below `node`, ascending. */
export function subtreeHeights(
  merges: Merge[],
  n: number,
  node: number,
): number[] {
  const out: number[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current < n) continue;
    const merge = merges[current - n];
    if (current !== node) out.push(merge.distance);
    stack.push(merge.a, merge.b);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Threshold that opens a cluster into a useful number of sub-clusters. Taken
 * as a quantile of the subtree's own merge heights, because one fixed global
 * value shatters a tight cluster and leaves a loose one whole.
 */
export function subCutThreshold(
  merges: Merge[],
  n: number,
  node: number,
  quantile: number,
): number {
  const heights = subtreeHeights(merges, n, node);
  if (heights.length === 0) return 0;
  const index = Math.min(
    heights.length - 1,
    Math.max(0, Math.round(quantile * (heights.length - 1))),
  );
  return heights[index];
}

/**
 * Every merge height, ascending. The granularity slider maps its position onto
 * a quantile of this rather than onto the raw distance range, so each step
 * changes the cluster count by a similar amount instead of most of the travel
 * doing nothing.
 */
export function sortedHeights(merges: Merge[]): number[] {
  return merges.map((m) => m.distance).sort((a, b) => a - b);
}

/**
 * How many levels below a merge feed its inconsistency score.
 *
 * Deeper than scipy's default of 2, measured rather than assumed: at depth 2 a
 * merge joining an internally loose topic to an unrelated one did not stand
 * out, because its own children were already tall. Widening the window one
 * level made that boundary visible and split four pull-request tabs back out
 * of a news cluster.
 */
const INCONSISTENCY_DEPTH = 3;

/**
 * Inconsistency coefficient per merge: how far a merge's height sits above the
 * merges just beneath it, measured in their own standard deviations.
 *
 * This is what a single absolute height threshold cannot do. Tabs about one
 * tight topic merge at small distances and tabs about a broad one merge at
 * large distances, so any one global cut shreds the broad topic or fuses the
 * tight ones. A merge that towers over its own children is a real boundary
 * whatever its absolute height, and a merge that continues at roughly the
 * height below it is not.
 *
 * Zero where there is too little beneath a merge to say, which keeps small
 * subtrees together rather than splitting them on noise.
 */
export function inconsistencies(merges: Merge[], n: number): Float64Array {
  const out = new Float64Array(merges.length);

  for (let i = 0; i < merges.length; i++) {
    const heights: number[] = [];
    const stack: Array<[number, number]> = [[n + i, 1]];
    while (stack.length > 0) {
      const [node, level] = stack.pop()!;
      if (node < n || level > INCONSISTENCY_DEPTH) continue;
      const merge = merges[node - n];
      heights.push(merge.distance);
      stack.push([merge.a, level + 1], [merge.b, level + 1]);
    }

    if (heights.length < 2) continue;
    let sum = 0;
    for (const h of heights) sum += h;
    const mean = sum / heights.length;
    let variance = 0;
    for (const h of heights) variance += (h - mean) * (h - mean);
    const deviation = Math.sqrt(variance / heights.length);
    if (deviation === 0) continue;
    out[i] = (merges[i].distance - mean) / deviation;
  }

  return out;
}

/**
 * The largest inconsistency anywhere in each node's subtree, indexed by node
 * id. A subtree is only emitted as one cluster when every merge inside it is
 * consistent, matching scipy's `fcluster(criterion="inconsistent")`.
 */
export function maxInconsistencies(
  merges: Merge[],
  n: number,
  scores: Float64Array,
): Float64Array {
  const out = new Float64Array(n + merges.length);
  // Merges are emitted children-before-parents, so one forward pass suffices.
  for (let i = 0; i < merges.length; i++) {
    const { a, b } = merges[i];
    out[n + i] = Math.max(scores[i], out[a], out[b]);
  }
  return out;
}

/**
 * Slice the dendrogram wherever the structure says to, rather than at one
 * fixed height. `threshold` is an inconsistency value, not a distance.
 */
export function cutTreeInconsistent(
  merges: Merge[],
  n: number,
  threshold: number,
  maxScores: Float64Array,
  precomputed?: number[][],
): CutCluster[] {
  if (n === 0) return [];
  if (merges.length === 0) return [{ node: 0, leaves: [0], height: 0 }];

  const members = precomputed ?? collectMembers(merges, n);
  const out: CutCluster[] = [];
  const stack = [n + merges.length - 1];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node < n) {
      out.push({ node, leaves: members[node], height: 0 });
      continue;
    }
    if (maxScores[node] <= threshold) {
      out.push({ node, leaves: members[node], height: merges[node - n].distance });
      continue;
    }
    const { a, b } = merges[node - n];
    stack.push(a, b);
  }

  return out.sort((x, y) => y.leaves.length - x.leaves.length);
}

/**
 * Distinct subtree-max inconsistency values, ascending, for the slider to
 * index into. Same reason as sortedHeights: quantiles keep every slider
 * position meaningful.
 */
export function sortedInconsistencies(maxScores: Float64Array): number[] {
  const unique = [...new Set(Array.from(maxScores))].sort((a, b) => a - b);
  return unique;
}

/**
 * Index pairs whose cosine similarity is at or above `threshold`.
 *
 * Reads raw embeddings rather than the matrix from distanceMatrix(), since the
 * structural factors there would report same-domain tabs as duplicates of each
 * other on shape alone.
 *
 * `eligible` marks the tabs whose page was actually read. Two tabs nobody has
 * read embed almost identically whenever their titles and URL shapes match —
 * a dozen different tweets by one author all reduce to the same handful of
 * words — and calling those duplicates is a claim the data cannot support. It
 * is a statement about content, so it needs content.
 */
export function nearDuplicatePairs(
  items: ClusterInput[],
  threshold: number,
  eligible?: boolean[],
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const usable = (i: number) => eligible === undefined || eligible[i];
  for (let i = 0; i < items.length; i++) {
    if (!usable(i)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (!usable(j)) continue;
      if (dot(items[i].vec, items[j].vec) >= threshold) pairs.push([i, j]);
    }
  }
  return pairs;
}
