// Follow-up edits of a finished article in Vane's chat: "make it shorter", "rewrite the intro",
// "translate it to English". The earlier answer is read back (parseArticleAnswer), one model call
// rewrites it (prompts.rewrite), and the result goes through the same finishing as a new article:
// citations renumbered, sources list written by code, checks run. Pure except for the injected client.
import { ANSWER_MARKER } from '../image/present.mjs';
import { checkCitations, renumber, runChecks, sourcesSection } from './checks.mjs';
import { namesPost } from '../core/intent-article.mjs';
import { detectLanguage, fold, repairFinalNu, repairHomoglyphs, wordCount } from '../core/language.mjs';
import { createRoleCaller } from './llm.mjs';
import { DEFAULT_MODE, tokensFor } from './models.mjs';
import { prompts } from './prompts.mjs';

// The verbs that start an edit request. Questions ("why", "what", "explain"), anything with a question mark
// ("?", or ";" in Greek), thanks and praise ("Πολύ καλό, ευχαριστώ!") are not edits: Vane answers them.
const EN_EDIT = new RegExp(String.raw`^\s*(?:(?:ok(?:ay)?|now|and|but|then|please|can you|could you|would you)[,.]?\s+)*(?:make|shorten|lengthen|expand|trim|cut|condense|simplify|tighten|reword|rephrase|rewrite|revise|edit|change|replace|fix|improve|update|add|remove|delete|drop|translate|convert|redo|polish|adjust|extend|soften|sharpen|shorter|longer|simpler|more|less|too|slightly|a bit|a little)(?![\p{L}])`, 'iu');
// Over folded text: no accents, final sigma as sigma.
const EL_EDIT = new RegExp(String.raw`^\s*(?:(?:ok|τωρα|και|αλλα|παρακαλω|μπορεισ να|θα μπορουσεσ να)\s+)*(?:κανε|συντομευσε|κοντυνε|μικρυνε|μεγαλωσε|επεκτεινε|απλοποιησε|ξαναγραψε|γραψε ξανα|αναδιατυπωσε|αλλαξε|αντικαταστησε|διορθωσε|βελτιωσε|ενημερωσε|προσθεσε|αφαιρεσε|διαγραψε|σβησε|μεταφρασε|πιο|λιγο|περισσοτερο|λιγοτερο|πολυ)(?![\p{L}])`, 'iu');

const NOT_EDIT = /\?|\bthank|ευχαριστ|μπραβο|^\s*(?:πολυ|too|so|really|very)\s+(?:καλο|ωραιο|τελειο|ενδιαφερον|good|great|nice|interesting|perfect)(?!\p{L})/u;
export function isArticleEdit(text) {
  const t = String(text || '');
  // ";" is the Greek question mark (fold() turns U+037E into it); in English it is only a semicolon
  if (NOT_EDIT.test(fold(t)) || (/;/.test(fold(t)) && /[α-ω]/.test(fold(t)))) return false;
  if (namesPost(t)) return false; // a post made from the article: the rewrite would keep it an article
  return EN_EDIT.test(t) || EL_EDIT.test(fold(t));
}

// "add a section on costs", "πρόσθεσε μια παράγραφο για ...": facts the article does not have yet, so the edit
// searches first. Other edits ("shorter", "more formal") work with what the article already says.
const NEW_FACTS = /\b(?:add|include|expand|extend|elaborate|cover|mention|more (?:about|on|detail))\b|(?:^|[^\p{L}])(?:προσθεσ|συμπεριλαβ|επεκτειν|αναπτυξ|αναφερ|περισσοτερα (?:για|σχετικα))/u;
export const needsNewFacts = (instruction) => NEW_FACTS.test(fold(String(instruction || '')).toLowerCase());

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
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const line of list.split('\n')) {
    // "1. <a href="url">title</a>" (the web answer since 2026-10), "1. [title](url)" or a bare title
    const a = /^(\d+)\.\s+<a href="([^"]*)">(.*)<\/a>$/.exec(line.trim());
    const m = a ? null : /^(\d+)\.\s+(?:\[(.*)\]\((\S+)\)|(.+))$/.exec(line.trim());
    if (a) sources[Number(a[1]) - 1] = { title: unescape(a[3]), url: a[2], content: '' };
    else if (m) sources[Number(m[1]) - 1] = { title: m[2] ?? unescape(m[4]), url: m[3] || '', content: '' };
  }
  const body = head
    .replace(new RegExp(`\\[([${SUP}]+)\\]\\([^)\\s]*\\)`, 'g'), (_, sup) => `[${[...sup].map(c => SUP.indexOf(c)).join('')}]`)
    .replace(/\[\d+\](?:\s\[\d+\])+/g, (run) => `[${[...run.matchAll(/\d+/g)].map(x => x[0]).join(', ')}]`)
    .trim();
  return { body, sources: Array.from(sources, s => s || { title: '', url: '', content: '' }), lang: detectLanguage(body) };
}

// How many sources a search for an edit may add.
export const MAX_NEW_SOURCES = 8;

// -> { ok, article, language, mode, words, sources, degraded, checks, calls, cost, ms } | { ok: false, error }
// Same shape as the article pipeline's result, so renderArticleResult shows it. `retrieve(query)` (Vane's
// research, optional) is used when the request asks for something new; found pages are added after the old sources.
export function createArticleEditor({ client, log = () => {}, now = Date.now }) {
  const call = createRoleCaller({ client, log });
  return async function editArticle({ body, sources, instruction, lang, mode = DEFAULT_MODE, chains, prices, retrieve, onProgress = () => {} }) {
    const t0 = now();
    lang ||= detectLanguage(body);
    const emit = (e) => { try { onProgress(e); } catch { /* a throwing listener must not stop the edit */ } };
    const degraded = [];
    let fresh = [];
    if (retrieve && needsNewFacts(instruction)) {
      emit({ phase: 'sources', status: 'running' });
      const title = /^\s*#\s+(.+)$/m.exec(body)?.[1].trim() || '';
      let found = [];
      try { found = await retrieve(title ? `${title}: ${instruction}` : instruction); } catch (err) { log(`search for the edit failed: ${err.message}`); }
      const seen = new Set(sources.map(s => s.url).filter(Boolean));
      for (const s of found || []) if (s?.url && !seen.has(s.url) && fresh.length < MAX_NEW_SOURCES) { seen.add(s.url); fresh.push({ title: s.title || s.url, url: s.url, content: s.content || '' }); }
      emit({ phase: 'sources', status: 'done', note: `${fresh.length} new sources` });
      if (!fresh.length) degraded.push('the search found no new sources: the edit could only use what the article already says');
    }
    const all = [...sources, ...fresh];
    emit({ phase: 'edit', status: 'running' });
    // "longer" can grow the text: room for half as much again.
    const r = await call('rewrite', prompts.rewrite({ lang, article: body, sources: all, instruction, newFacts: fresh.length > 0 }), { chain: chains.draft, maxTokens: tokensFor('draft', Math.ceil(wordCount(body) * 1.5), lang), prices });
    emit({ phase: 'edit', status: r.ok ? 'ok' : 'failed' });
    const base = { language: lang, mode, calls: r.attempts.length, cost: r.cost };
    if (!r.ok) return { ok: false, fatal: r.fatal, status: r.status, error: `the edit failed: ${r.errors.join('; ')}`, ...base };
    sources = all;

    const next = lang === 'el' ? repairFinalNu(repairHomoglyphs(r.text).text).text : r.text;
    if (/^\s*#\s/m.test(body) && !/^\s*#\s/m.test(next)) return { ok: false, error: 'the edit lost the title, so the article was not changed', ...base };
    if (wordCount(next) < wordCount(body) * 0.25) return { ok: false, error: 'the edit left less than a quarter of the text, so the article was not changed', ...base };
    const raw = checkCitations(next, sources);
    if (raw.invalid.length) degraded.push(`removed citations to sources that do not exist: ${raw.invalid.map(n => `[${n}]`).join(' ')}`);
    const { text, used } = renumber(next, sources);
    const checks = runChecks(text, { lang, sources: used.length ? used : sources, targetWords: wordCount(text) });
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
