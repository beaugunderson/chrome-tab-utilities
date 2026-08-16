// Cluster naming by c-TF-IDF: treat each cluster as one document, then pick
// the terms that are frequent inside it and rare across the others. No model
// involved, so labels appear the instant the cut changes.
//
// Terms include adjacent word pairs, not just single words, because "pull
// request" and "interest rates" say far more than the words apart do. Original
// casing is preserved so proper nouns read as themselves.

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

// Hyphens stay inside a token: KOALA-6561, COVID-19 and e-commerce are each
// one term, and splitting them tiles the phrase into overlapping pairs that
// then knock each other out of the label.
const TOKEN_SPLIT = /[^\p{L}\p{N}+#-]+/u;
const KEYWORDS_PER_LABEL = 3;
/**
 * Total words a label may spend. Counting terms alone reads badly now that a
 * term can be a phrase: three of them runs to "Fed · holds interest · rates
 * steady" where "Fed · holds interest" says the same thing.
 */
const LABEL_WORD_BUDGET = 4;
/** Share of a cluster that must sit on one site before it earns a prefix. */
const SITE_PREFIX_SHARE = 0.6;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(TOKEN_SPLIT)) {
    // Two-character tokens are noise unless the punctuation is the name: c#,
    // f#, g+.
    if (raw.length < 3 && !/[+#]/.test(raw)) continue;
    if (raw.length < 2) continue;
    // A run of punctuation is not a term.
    if (!/[\p{L}\p{N}]/u.test(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    // Bare numbers survive at three digits or more, which keeps ticket and PR
    // numbers (koala 6561) while dropping counts and ordinals.
    out.push(raw);
  }
  return out;
}

/** Tokens with the casing they were written in, for building labels. */
function tokenizeWithSurface(text: string): Array<{ term: string; surface: string }> {
  const out: Array<{ term: string; surface: string }> = [];
  for (const raw of text.split(TOKEN_SPLIT)) {
    const term = raw.toLowerCase();
    if (term.length < 3 && !/[+#]/.test(term)) continue;
    if (term.length < 2) continue;
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    if (STOPWORDS.has(term)) continue;
    out.push({ term, surface: raw });
  }
  return out;
}

export interface LabelSource {
  /** Title plus any harvested heading; what the label is drawn from. */
  text: string;
  /** Display host, used for the site prefix. */
  site: string | null;
}

interface ClusterTerms {
  count: Map<string, number>;
  total: number;
  /** Most frequently seen casing for each term. */
  surfaces: Map<string, Map<string, number>>;
}

function collectTerms(cluster: LabelSource[]): ClusterTerms {
  const count = new Map<string, number>();
  const surfaces = new Map<string, Map<string, number>>();
  let total = 0;

  const note = (term: string, surface: string) => {
    count.set(term, (count.get(term) ?? 0) + 1);
    total++;
    let seen = surfaces.get(term);
    if (!seen) {
      seen = new Map();
      surfaces.set(term, seen);
    }
    seen.set(surface, (seen.get(surface) ?? 0) + 1);
  };

  for (const source of cluster) {
    const tokens = tokenizeWithSurface(source.text);
    for (let i = 0; i < tokens.length; i++) {
      note(tokens[i].term, tokens[i].surface);
      // Pairs come from within one title only, so two unrelated tabs never
      // manufacture a phrase between them.
      if (i + 1 < tokens.length) {
        note(
          `${tokens[i].term} ${tokens[i + 1].term}`,
          `${tokens[i].surface} ${tokens[i + 1].surface}`,
        );
      }
    }
  }

  return { count, total, surfaces };
}

function bestSurface(terms: ClusterTerms, term: string): string {
  const seen = terms.surfaces.get(term);
  if (!seen) return term;
  let best = term;
  let bestCount = -1;
  for (const [surface, n] of seen) {
    if (n > bestCount) {
      best = surface;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Distinctive terms per cluster, in the casing they were written in.
 *
 * Term frequency is measured within a cluster; the inverse document frequency
 * counts how many *clusters* contain the term, so a word every cluster shares
 * scores exactly zero rather than merely ranking low.
 */
export function clusterKeywords(
  clusters: LabelSource[][],
  perCluster = KEYWORDS_PER_LABEL,
): string[][] {
  const perClusterTerms = clusters.map(collectTerms);
  const clustersContaining = new Map<string, number>();
  for (const terms of perClusterTerms) {
    for (const term of terms.count.keys()) {
      clustersContaining.set(term, (clustersContaining.get(term) ?? 0) + 1);
    }
  }

  const clusterCount = clusters.length || 1;
  const idfOf = (term: string) =>
    clusterCount <= 1
      ? 1
      : Math.log(clusterCount / (clustersContaining.get(term) ?? 1));

  // Words carried by every cluster say nothing, and a phrase containing one
  // smuggles it back in: "| GitHub" on every title yields a per-cluster
  // "github something" that scores well while meaning nothing. Rule them out
  // before anything else, so the informative half can stand on its own.
  const ubiquitous = new Set<string>();
  for (const term of clustersContaining.keys()) {
    if (!term.includes(" ") && idfOf(term) <= 0) ubiquitous.add(term);
  }
  const usable = (term: string) =>
    !term.split(" ").some((word) => ubiquitous.has(word));

  return perClusterTerms.map((terms, i) => {
    const total = terms.total || 1;

    // A word that never appears outside one phrase is already said by that
    // phrase. "ceasefire" and "talks" both occurring exactly as often as
    // "ceasefire talks" means the phrase is the real term, so the two halves
    // drop out instead of crowding the label.
    const subsumed = new Set<string>();
    for (const [term, frequency] of terms.count) {
      if (!term.includes(" ") || !usable(term)) continue;
      for (const word of term.split(" ")) {
        if (terms.count.get(word) === frequency) subsumed.add(word);
      }
    }

    const scored: Array<{ term: string; score: number }> = [];
    for (const [term, frequency] of terms.count) {
      if (subsumed.has(term)) continue;
      if (!usable(term)) continue;
      // A term appearing in only one tab of a large cluster describes that tab,
      // not the cluster.
      if (clusters[i].length > 3 && frequency < 2) continue;
      const idf = idfOf(term);
      if (idf <= 0) continue;
      scored.push({ term, score: (frequency / total) * idf });
    }

    scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

    // Overlapping phrases say the same thing twice: having taken "interest
    // rates", skip "rates steady".
    const chosen: string[] = [];
    const covered = new Set<string>();
    let spent = 0;
    for (const { term } of scored) {
      if (chosen.length >= perCluster) break;
      const words = term.split(" ");
      if (words.some((w) => covered.has(w))) continue;
      // Always take the top term, however long, so a cluster is never nameless.
      if (chosen.length > 0 && spent + words.length > LABEL_WORD_BUDGET) continue;
      chosen.push(term);
      spent += words.length;
      for (const word of words) covered.add(word);
    }

    return chosen.map((term) => bestSurface(terms, term));
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
 * Human-facing cluster names, e.g. `github.com · pull request`.
 * Computed for all clusters at once because the IDF term is cross-cluster.
 */
export function labelClusters(clusters: LabelSource[][]): string[] {
  const keywords = clusterKeywords(clusters);
  return clusters.map((cluster, i) => {
    const site = dominantSite(cluster);
    const words = keywords[i].join(" · ");
    if (words && site) return `${site} · ${words}`;
    if (words) return words;
    if (site) return site;
    return "untitled";
  });
}
