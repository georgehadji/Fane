// Quality gate numbers from reasoner's article method (ARTICLE_METHOD_SPECIFICATION.md, "blog"
// policy in domain/article_domain.py): each audit dimension has a floor and a weight, and an
// article passes when every floor holds and the weighted mean is at least 0.6.
export const AUDIT_DIMENSIONS = ['thesis_advancement', 'claim_support', 'internal_consistency', 'transition_quality', 'redundancy_removed', 'citation_accuracy'];
const POLICY = {
  claim_support: [0.6, 2],
  citation_accuracy: [0.6, 2],
  internal_consistency: [0.55, 2],
  thesis_advancement: [0.5, 1],
  transition_quality: [0.5, 1],
  redundancy_removed: [0.5, 1],
};
export const MIN_AUDIT_SCORE = 0.6;
export const MIN_CLAIM_SUPPORT = 0.5; // below this the article says it is thinly sourced

const num = (x) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : null);

// scores: { dimension: 0..1 } from the audit model. A missing or out-of-range score counts as 0.
export function auditResult(scores) {
  let sum = 0, weight = 0;
  const failures = [];
  for (const [dim, [floor, w]] of Object.entries(POLICY)) {
    const s = num(scores?.[dim]) ?? 0;
    sum += s * w;
    weight += w;
    if (s < floor) failures.push(`${dim} ${s.toFixed(2)} < ${floor}`);
  }
  const score = Math.round((sum / weight) * 100) / 100;
  return { score, failures, passes: !failures.length && score >= MIN_AUDIT_SCORE };
}

const VERDICTS = new Set(['supported', 'partial', 'unsupported']);

// The fact-check model's claims -> clean ledger entries.
export function claimLedger(raw) {
  return (Array.isArray(raw?.claims) ? raw.claims : [])
    .filter(c => c && typeof c.claim === 'string' && VERDICTS.has(c.verdict))
    .slice(0, 25)
    .map(c => ({ claim: c.claim.slice(0, 300), source: Number.isInteger(c.source) ? c.source : null, verdict: c.verdict, note: String(c.note || '').slice(0, 300) }));
}

export const claimSupportRatio = (ledger) => (ledger.length ? Math.round((ledger.filter(c => c.verdict === 'supported').length / ledger.length) * 1000) / 1000 : null);
