// Researched reports (format 'report', formats.mjs REPORT): the pure parts. The pipeline asks a model for a plan of
// sub-questions, researches each one, asks for notes per sub-question, then writes one report. A model's JSON is read
// here, and it is the trust boundary: counts, lengths and source numbers are enforced in code, whatever the model said.

const text = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const key = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// {"sub_questions": [{"question", "query", "covers"}]} -> [{question, query, covers}], at most `max`, no repeats.
// An item with no question is dropped; a missing query is the question. [] when nothing usable came back.
export function normalizePlan(data, { max }) {
  const list = Array.isArray(data?.sub_questions) ? data.sub_questions : Array.isArray(data?.questions) ? data.questions : [];
  const seen = new Set(), out = [];
  for (const it of list) {
    const question = text(typeof it === 'string' ? it : it?.question, 200);
    const k = key(question);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ question, query: text(it?.query, 200) || question, covers: text(it?.covers, 200) });
    if (out.length >= max) break;
  }
  return out;
}

// One list of sources per sub-question ([] for a failed research) -> one list, numbered by sub-question in order, with
// each page once (a page found by two sub-questions keeps its first place and belongs to both groups).
// -> { sources, groups: [[number...]] } with numbers 1-based into `sources`. Per question at most `perQuestion`, in all `maxSources`.
export function mergeSources(lists, { perQuestion, maxSources }) {
  const sources = [], at = new Map();
  const groups = lists.map((list) => {
    const group = [];
    for (const s of list || []) {
      if (group.length >= perQuestion) break;
      if (!s?.url) continue;
      if (!at.has(s.url)) {
        if (sources.length >= maxSources) continue;
        sources.push({ title: s.title || s.url, url: s.url, content: s.content || '' });
        at.set(s.url, sources.length);
      }
      if (!group.includes(at.get(s.url))) group.push(at.get(s.url));
    }
    return group;
  });
  return { sources, groups };
}

// {"facts": [{"text", "sources": [n]}]} -> [{text, sources}], sources only from `allowed` (this sub-question's numbers),
// at most `max` facts; a fact that cites nothing allowed is dropped: the report cites only what the notes carry.
export function normalizeNotes(data, allowed, { max = 8 } = {}) {
  const ok = new Set(allowed);
  const facts = [];
  for (const f of Array.isArray(data?.facts) ? data.facts : []) {
    const t = text(f?.text, 400);
    const nums = [...new Set((Array.isArray(f?.sources) ? f.sources : [f?.source]).map(Number).filter(n => ok.has(n)))].sort((a, b) => a - b);
    if (t && nums.length) facts.push({ text: t, sources: nums });
    if (facts.length >= max) break;
  }
  return facts;
}

// fn over items, at most `limit` at a time, results in order; never throws (a rejection is `{ error }`).
export async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { value: await fn(items[i], i) }; } catch (error) { out[i] = { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
