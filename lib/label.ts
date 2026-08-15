// Cluster naming by c-TF-IDF: treat each cluster as one document, then pick
// the terms that are frequent inside it and rare across the others. No model
// involved, so labels appear the instant the cut changes.

const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at",
  "be", "been", "best", "but", "by", "can", "com", "could", "did", "do",
  "does", "for", "from", "get", "had", "has", "have", "her", "his", "how",
  "http", "https", "i", "if", "in", "into", "is", "it", "its", "just", "like",
  "make", "may", "me", "more", "most", "my", "new", "no", "not", "now", "of",
  "on", "one", "only", "or", "other", "our", "out", "over", "own", "page",
  "res", "said", "see", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "to", "top", "two", "up", "use", "very", "via", "was", "way", "we", "were",
  "what", "when", "where", "which", "while", "who", "why", "will", "with",
  "would", "you", "your",
]);

const TOKEN_SPLIT = /[^\p{L}\p{N}+#]+/u;
const KEYWORDS_PER_LABEL = 3;
/** Share of a cluster that must sit on one site before it earns a prefix. */
const SITE_PREFIX_SHARE = 0.6;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(TOKEN_SPLIT)) {
    // Two-character tokens are noise unless the punctuation is the name: c#,
    // f#, g+.
    if (raw.length < 3 && !/[+#]/.test(raw)) continue;
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    // Bare numbers survive at three digits or more, which keeps ticket and PR
    // numbers (koala 6561) while dropping counts and ordinals.
    out.push(raw);
  }
  return out;
}

export interface LabelSource {
  /** Title plus any harvested heading; what the label is drawn from. */
  text: string;
  /** Display host, used for the site prefix. */
  site: string | null;
}

/**
 * Distinctive keywords per cluster.
 *
 * Term frequency is measured within a cluster; the inverse document frequency
 * counts how many *clusters* contain the term, so a word every cluster shares
 * scores near zero rather than dominating every label.
 */
export function clusterKeywords(
  clusters: LabelSource[][],
  perCluster = KEYWORDS_PER_LABEL,
): string[][] {
  const counts: Array<Map<string, number>> = [];
  const totals: number[] = [];
  const clustersContaining = new Map<string, number>();

  for (const cluster of clusters) {
    const count = new Map<string, number>();
    let total = 0;
    for (const source of cluster) {
      for (const token of tokenize(source.text)) {
        count.set(token, (count.get(token) ?? 0) + 1);
        total++;
      }
    }
    for (const term of count.keys()) {
      clustersContaining.set(term, (clustersContaining.get(term) ?? 0) + 1);
    }
    counts.push(count);
    totals.push(total);
  }

  const clusterCount = clusters.length || 1;

  return counts.map((count, i) => {
    const total = totals[i] || 1;
    const scored: Array<{ term: string; score: number }> = [];
    for (const [term, frequency] of count) {
      // A term appearing in only one tab of a large cluster describes that tab,
      // not the cluster.
      if (clusters[i].length > 3 && frequency < 2) continue;
      const tf = frequency / total;
      // Plain log(N/df), which lands at exactly zero for a term every cluster
      // shares so it drops out rather than merely ranking low. With a single
      // cluster there is nothing to contrast against, so fall back to raw
      // frequency.
      const containing = clustersContaining.get(term) ?? 1;
      const idf = clusterCount <= 1 ? 1 : Math.log(clusterCount / containing);
      if (idf <= 0) continue;
      scored.push({ term, score: tf * idf });
    }
    scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
    return scored.slice(0, perCluster).map((s) => s.term);
  });
}

/** The site hosting at least SITE_PREFIX_SHARE of a cluster, if any. */
export function dominantSite(cluster: LabelSource[]): string | null {
  if (cluster.length === 0) return null;
  const tally = new Map<string, number>();
  for (const { site } of cluster) {
    if (!site) continue;
    tally.set(site, (tally.get(site) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [site, count] of tally) {
    if (count > bestCount) {
      best = site;
      bestCount = count;
    }
  }
  return bestCount / cluster.length >= SITE_PREFIX_SHARE ? best : null;
}

/**
 * Human-facing cluster names, e.g. `github.com · pull request review`.
 * Computed for all clusters at once because the IDF term is cross-cluster.
 */
export function labelClusters(clusters: LabelSource[][]): string[] {
  const keywords = clusterKeywords(clusters);
  return clusters.map((cluster, i) => {
    const site = dominantSite(cluster);
    const words = keywords[i].join(" ");
    if (words && site) return `${site} · ${words}`;
    if (words) return words;
    if (site) return site;
    return "untitled";
  });
}
