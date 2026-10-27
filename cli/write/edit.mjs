// Follow-up edits of a finished article in Vane's chat: "make it shorter", "rewrite the intro",
// "translate it to English". The earlier answer is read back (parseArticleAnswer), one model call
// rewrites it (prompts.rewrite), and the result goes through the same finishing as a new article:
// citations renumbered, sources list written by code, checks run. Pure except for the injected client.
import { ANSWER_MARKER } from '../image/present.mjs';
import { checkCitations, renumber, runChecks, sourcesSection } from './checks.mjs';
import { detectLanguage, fold, repairHomoglyphs, wordCount } from './language.mjs';
import { createRoleCaller } from './llm.mjs';
import { DEFAULT_MODE, tokensFor } from './models.mjs';
import { prompts } from './prompts.mjs';

// The verbs that start an edit request. Questions ("why", "what", "explain") never match.
const EN_EDIT = new RegExp(String.raw`^\s*(?:(?:ok(?:ay)?|now|and|but|then|please|can you|could you|would you)[,.]?\s+)*(?:make|shorten|lengthen|expand|trim|cut|condense|simplify|tighten|reword|rephrase|rewrite|revise|edit|change|replace|fix|improve|update|add|remove|delete|drop|translate|convert|redo|polish|adjust|extend|soften|sharpen|shorter|longer|simpler|more|less|too|slightly|a bit|a little)(?![\p{L}])`, 'iu');
// Over folded text: no accents, final sigma as sigma.
const EL_EDIT = new RegExp(String.raw`^\s*(?:(?:ok|τωρα|και|αλλα|παρακαλω|μπορεισ να|θα μπορουσεσ να)\s+)*(?:κανε|συντομευσε|κοντυνε|μικρυνε|μεγαλωσε|επεκτεινε|απλοποιησε|ξαναγραψε|γραψε ξανα|αναδιατυπωσε|αλλαξε|αντικαταστησε|διορθωσε|βελτιωσε|ενημερωσε|προσθεσε|αφαιρεσε|διαγραψε|σβησε|μεταφρασε|πιο|λιγο|περισσοτερο|λιγοτερο|πολυ)(?![\p{L}])`, 'iu');

export const isArticleEdit = (text) => EN_EDIT.test(String(text || '')) || EL_EDIT.test(fold(String(text || '')));

// "translate it to English", "στα αγγλικά": the language the edited article should be in, else `fallback`.
export function targetLanguage(instruction, fallback) {
  const t = fold(String(instruction || ''));
  const m = /(?:translat\p{L}*|convert|μεταφρασ\p{L}*|(?:\bin|\bto|\binto)|στα|σε)\s+(?:\p{L}+\s+){0,2}?(english|greek|αγγλικ\p{L}*|ελληνικ\p{L}*)(?:,?\s+(?:please|παρακαλω|now|τωρα))?\s*[.!;]?\s*$/u.exec(t);
  if (!m) return fallback;
  return /^(?:english|αγγλικ)/u.test(m[1]) ? 'en' : 'el';
}

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SOURCES_AT = /\n\n## (?:Sources|Πηγές)\n\n/;

// The text of an earlier answer -> { body, sources, lang } | null. The answer is what renderArticleResult
// wrote: the article with citations as superscript links, the sources list, then the status paragraph and the
// invisible marker. The body comes back with plain [n] citations, as the model wrote them.
export function parseArticleAnswer(answer) {
  const text = String(answer || '').replace(ANSWER_MARKER, '').replace(/\s*<p role="status"[\s\S]*?<\/p>\s*$/, '').trim();
  const [head, list = ''] = text.split(SOURCES_AT);
  if (!/^\s*#\s+\S/m.test(head) || wordCount(head) < 80) return null;
  const sources = [];
  for (const line of list.split('\n')) {
    const m = /^(\d+)\.\s+(?:\[(.*)\]\((\S+)\)|(.+))$/.exec(line.trim());
    if (m) sources[Number(m[1]) - 1] = { title: m[2] ?? m[4], url: m[3] || '', content: '' };
  }
  const body = head
    .replace(new RegExp(`\\[([${SUP}]+)\\]\\([^)\\s]*\\)`, 'g'), (_, sup) => `[${[...sup].map(c => SUP.indexOf(c)).join('')}]`)
    .replace(/\[\d+\](?:\s\[\d+\])+/g, (run) => `[${[...run.matchAll(/\d+/g)].map(x => x[0]).join(', ')}]`)
    .trim();
  return { body, sources: Array.from(sources, s => s || { title: '', url: '', content: '' }), lang: detectLanguage(body) };
}

// -> { ok, article, language, mode, words, sources, degraded, checks, calls, cost, ms } | { ok: false, error }
// Same shape as the article pipeline's result, so renderArticleResult shows it.
export function createArticleEditor({ client, log = () => {}, now = Date.now }) {
  const call = createRoleCaller({ client, log });
  return async function editArticle({ body, sources, instruction, lang, mode = DEFAULT_MODE, chains, onProgress = () => {} }) {
    const t0 = now();
    lang ||= detectLanguage(body);
    const emit = (e) => { try { onProgress(e); } catch { /* a throwing listener must not stop the edit */ } };
    emit({ phase: 'edit', status: 'running' });
    // "longer" can grow the text: room for half as much again.
    const r = await call('rewrite', prompts.rewrite({ lang, article: body, sources, instruction }), { chain: chains.draft, maxTokens: tokensFor('draft', Math.ceil(wordCount(body) * 1.5), lang) });
    emit({ phase: 'edit', status: r.ok ? 'ok' : 'failed' });
    const base = { language: lang, mode, calls: r.attempts.length, cost: r.cost };
    if (!r.ok) return { ok: false, fatal: r.fatal, status: r.status, error: `the edit failed: ${r.errors.join('; ')}`, ...base };

    const degraded = [];
    const next = lang === 'el' ? repairHomoglyphs(r.text).text : r.text;
    if (/^\s*#\s/m.test(body) && !/^\s*#\s/m.test(next)) return { ok: false, error: 'the edit lost the title, so the article was not changed', ...base };
    if (wordCount(next) < wordCount(body) * 0.25) return { ok: false, error: 'the edit left less than a quarter of the text, so the article was not changed', ...base };
    const raw = checkCitations(next, sources);
    if (raw.invalid.length) degraded.push(`removed citations to sources that do not exist: ${raw.invalid.map(n => `[${n}]`).join(' ')}`);
    const { text, used } = renumber(next, sources);
    const checks = runChecks(text, { lang, sources: used, targetWords: wordCount(text) });
    for (const i of checks.items) if (i.level === 'fail') degraded.push(`check "${i.name}" failed: ${i.detail}`);
    return {
      ok: true,
      article: text.trimEnd() + sourcesSection(used, lang),
      words: checks.words,
      sources: used,
      degraded,
      checks,
      ...base,
      ms: now() - t0,
    };
  };
}
