// Deterministic checks on a finished article: no model, no network, so they cost nothing, run on
// every tier and are testable. They catch what models do wrong silently: leaked "thinking",
// citations to sources that do not exist, numbers that are in no cited source, Latin look-alike
// letters in Greek words, a text far from the requested length, machine-sounding phrasing.
// Citations are bracketed source numbers, [3] or [1, 4], as in Vane's own answers; the
// "Sources" list is written by code (sourcesSection), so a model cannot invent a URL.
import { POSTS, isPost } from './formats.mjs';
import { LANGUAGE_NAMES, countTells, findHomoglyphs, greekTypography, wordCount } from './language.mjs';

// "[3]", "[1, 4]" and ranges "[2–4]" (models write them although the prompt asks for lists)
const CITE = /\[(\d{1,2}(?:\s*[-–]\s*\d{1,2})?(?:\s*[,;]\s*\d{1,2}(?:\s*[-–]\s*\d{1,2})?)*)\]/g;
const citeNumbers = (group) => group.split(/[,;]/).flatMap((s) => {
  const [a, b = a] = s.split(/[-–]/).map(x => Number(x.trim()));
  return b >= a && b - a < 20 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a, b];
});

// Sentences of the article body (headings, lists of sources and fragments left out).
export function sentences(text) {
  return String(text || '')
    .split('\n')
    .filter(line => line.trim() && !/^\s*#/.test(line))
    .flatMap(line => line.split(/(?<=[.!?;…·])\s+(?=[\p{Lu}«"“\[(])/u))
    .map(s => s.trim())
    .filter(s => wordCount(s.replace(CITE, '')) >= 5);
}

// "1,000" and "1.000" are a thousand; "3,5" and "3.5" are three and a half.
const normNum = (x) => (/^\d{1,3}(?:[.,]\d{3})+$/.test(x) ? x.replace(/[.,]/g, '') : x.replace(',', '.'));
const numbersIn = (text) => [...new Set((String(text).match(/\d[\d.,]*\d|\d/g) || []).map(normNum))].filter(x => x.replace(/\D/g, '').length >= 2);

// -> { used: [n...], invalid: [n...], cited, uncited, numbersMissing: [{ sentence, numbers }] }
export function checkCitations(article, sources) {
  const used = new Set(), invalid = new Set();
  let cited = 0, uncited = 0;
  const numbersMissing = [];
  // every bracketed number counts, in sentences of any length
  for (const m of String(article).matchAll(CITE)) for (const n of citeNumbers(m[1])) (n >= 1 && n <= sources.length ? used : invalid).add(n);
  for (const s of sentences(article)) {
    const cites = [...s.matchAll(CITE)].flatMap(m => citeNumbers(m[1]));
    if (!cites.length) { uncited++; continue; }
    cited++;
    const valid = cites.filter(n => n >= 1 && n <= sources.length);
    // an article read back for an edit has its sources' titles and links but not their text
    if (!valid.some(n => sources[n - 1].content)) continue;
    const have = new Set(valid.flatMap(n => numbersIn(`${sources[n - 1].title || ''} ${sources[n - 1].content || ''}`)));
    const missing = numbersIn(s.replace(CITE, ' ')).filter(x => !have.has(x));
    if (missing.length) numbersMissing.push({ sentence: s, numbers: missing });
  }
  return { used: [...used].sort((a, b) => a - b), invalid: [...invalid].sort((a, b) => a - b), cited, uncited, numbersMissing };
}

// Number the cited sources 1, 2, 3 in order of first appearance and drop numbers that name no
// source. -> { text, used: [source...] } with `used[i]` now cited as [i + 1].
export function renumber(article, sources) {
  const order = new Map();
  const text = String(article).replace(CITE, (_, group) => {
    const nums = citeNumbers(group).filter(n => n >= 1 && n <= sources.length);
    for (const n of nums) if (!order.has(n)) order.set(n, order.size + 1);
    return nums.length ? `[${[...new Set(nums.map(n => order.get(n)))].sort((a, b) => a - b).join(', ')}]` : '';
  }).replace(/[ \t]+([.,;:!?])/g, '$1');
  return { text, used: [...order.keys()].map(n => sources[n - 1]) };
}

// Only web links become links; spaces and parentheses would end a Markdown link early.
export const isWebUrl = (u) => /^https?:\/\//i.test(String(u || ''));
export const safeUrl = (u) => String(u).replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
// "[1]" and "[2, 3]" -> superscript links to the sources: ¹ ²  ³. Vane's web UI turns every "[n]" into a chip
// for its own research sources (a different numbering), and does not touch superscript digits.
// `used` is the list renumber() returned, so [n] is used[n - 1].
export function linkCitations(text, used) {
  return String(text).replace(CITE, (_, group) => citeNumbers(group).map((n) => {
    const sup = String(n).replace(/\d/g, d => SUPERSCRIPT[d]);
    const s = used[n - 1];
    return s && isWebUrl(s.url) ? `[${sup}](${safeUrl(s.url)})` : sup;
  }).join(' '));
}

const HEADING = { en: 'Sources', el: 'Πηγές' };
// `html` is for Vane's web UI: it rewrites every "[...]" of an answer that has sources, split at its commas
// ("[Earth, moon and sun](url)" showed as "[Earth]" and a link "moon and sun"), so links there are <a> tags.
const htmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlHref = (u) => safeUrl(u).replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
export function sourcesSection(used, lang, { html = false } = {}) {
  if (!used.length) return '';
  const clean = (s) => String(s || '').replace(/[\[\]\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  // pages with a placeholder title ("sample", "Microsoft Word - file.docx") are named by their site instead
  const JUNK = /^(?:sample|untitled|index|home|document|microsoft word\b.*|.{0,3})$/i;
  const label = (s) => {
    const title = clean(s.title);
    if (title && !JUNK.test(title)) return title;
    try { return new URL(s.url).hostname.replace(/^www\./, '') || s.url; } catch { return String(s.url || ''); }
  };
  const link = (s) => (!isWebUrl(s.url) ? (html ? htmlText(label(s)) : label(s))
    : html ? `<a href="${htmlHref(s.url)}">${htmlText(label(s))}</a>` : `[${label(s)}](${safeUrl(s.url)})`);
  return `\n\n## ${HEADING[lang] || HEADING.en}\n\n${used.map((s, i) => `${i + 1}. ${link(s)}`).join('\n')}\n`;
}

// A post is published without its [n] markers; its sources go in the first comment (formats.mjs says why).
export const stripCitations = (text) => String(text).replace(/\s*\[(?:\d{1,2}(?:\s*[-–,;]\s*\d{1,2})*)\]/g, '').replace(/[ \t]+([.,;:!?·])/g, '$1').replace(/[ \t]+$/gm, '').trim();

const COMMENT_HEAD = { en: 'Sources', el: 'Πηγές' };
// Plain text, as it is pasted into the comment: "Sources:\n1. Title: https://…".
export function firstComment(used, lang) {
  if (!used.length) return '';
  const title = (s) => String(s.title || '').replace(/\s+/g, ' ').trim() || String(s.url || '');
  return `${COMMENT_HEAD[lang] || COMMENT_HEAD.en}:\n${used.map((s, i) => `${i + 1}. ${title(s)}${isWebUrl(s.url) && title(s) !== s.url ? `: ${s.url}` : ''}`).join('\n')}`;
}

// "Mathematical" letters (U+1D400–1D7FF) used as fake bold or italic: screen readers spell them out, search misses them.
const FAKE_STYLE = /[\u{1D400}-\u{1D7FF}]/u;
const MARKDOWN = /^\s{0,3}#{1,6}\s|\*\*[^*\n]+\*\*|__[^_\n]+__|^\s*[-*+]\s+\S|^\s*\d+[.)]\s+\S/m;

// Checks of the post as it will be published (citations stripped). -> items in runChecks' shape.
export function postChecks(post, platform) {
  const p = POSTS[platform];
  const items = [];
  const add = (name, level, detail) => items.push({ name, level, detail });
  const chars = [...post].length;
  if (chars > p.maxChars) add('post-length', 'fail', `${chars} characters; ${p.name} allows ${p.maxChars}`);
  else add('post-length', 'ok', `${chars} characters`);
  const hook = [...(post.split(/\n/).find(l => l.trim()) || '')].length;
  if (hook > p.foldChars) add('hook', 'warn', `the first line is ${hook} characters; ${p.name} shows about ${p.foldChars} before "see more"`);
  if (FAKE_STYLE.test(post)) add('fake-bold', 'fail', 'Unicode "bold" or "italic" letters: screen readers spell them out and search cannot find them');
  if (MARKDOWN.test(post)) add('markdown', 'warn', `headings, bold or list markers: ${p.name} shows them as plain symbols`);
  if (/https?:\/\//i.test(post)) add('link-in-post', 'warn', 'a link in the post costs reach; links belong in the first comment');
  const tags = (post.match(/(?<![\p{L}\p{N}&])#[\p{L}\p{N}_]+/gu) || []).length;
  if (tags > p.hashtags) add('hashtags', 'warn', `${tags} hashtag${tags === 1 ? '' : 's'}; at most ${p.hashtags} for ${p.name}`);
  return items;
}

// Sentence-length spread (std / mean). Machine text is even; people vary. Under ~0.3 reads flat.
export function rhythm(text) {
  const lens = sentences(text).map(s => wordCount(s));
  if (lens.length < 8) return { sentences: lens.length, mean: null, cv: null };
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
  return { sentences: lens.length, mean: Math.round(mean * 10) / 10, cv: Math.round((sd / mean) * 100) / 100 };
}

export const THINKING_LEAK = /^\s*(?:thinking process|<think>|<thinking>|let me think|okay, let me|first, i need to)|<\/think>/i;
export const MAX_TELLS_PER_THOUSAND = 8;

// -> { ok, items: [{ name, level: 'ok' | 'warn' | 'fail', detail }] }; `ok` is false only for a fail.
// `body` is the article as the model wrote it (with the model's own [n] numbers). For a post (`format` is a
// platform), the shape is checked on the text as it will be published, without the [n] markers.
export function runChecks(body, { lang = 'en', sources = [], targetWords = 900, format = 'article' } = {}) {
  const items = [];
  const add = (name, level, detail) => items.push({ name, level, detail });
  const words = wordCount(body);
  const ratio = words / targetWords;

  if (THINKING_LEAK.test(body)) add('thinking-leak', 'fail', 'the text contains model reasoning, not an article');
  else add('thinking-leak', 'ok', '');

  if (ratio < 0.4 || ratio > 2) add('length', 'fail', `${words} words for a target of ${targetWords}`);
  else if (ratio < 0.75 || ratio > 1.35) add('length', 'warn', `${words} words for a target of ${targetWords}`);
  else add('length', 'ok', `${words} words`);

  if (isPost(format)) items.push(...postChecks(stripCitations(body), format));
  else if (!/^\s*#\s+\S/m.test(body)) add('title', 'warn', 'no "# title" line');

  if (sources.length) {
    const c = checkCitations(body, sources);
    if (c.invalid.length) add('citations', 'fail', `cites source ${c.invalid.map(n => `[${n}]`).join(', ')}, which does not exist`);
    else if (!c.cited) add('citations', 'fail', 'no citations although sources were given');
    else add('citations', 'ok', `${c.cited} cited sentence${c.cited === 1 ? '' : 's'}, ${c.used.length} source${c.used.length === 1 ? '' : 's'} used, ${c.uncited} uncited`);
    if (c.numbersMissing.length) add('numbers', 'warn', `${c.numbersMissing.length} sentence${c.numbersMissing.length === 1 ? '' : 's'} with numbers not in the cited source (${c.numbersMissing.slice(0, 3).map(m => m.numbers.join('/')).join('; ')})`);
  }

  if (lang === 'el') {
    const glyphs = findHomoglyphs(body);
    if (glyphs.length) add('latin-letters-in-greek', 'fail', `${glyphs.length} word${glyphs.length === 1 ? '' : 's'} mix Greek and Latin letters: ${glyphs.slice(0, 5).join(', ')}`);
    const typo = greekTypography(body);
    if (typo.length) add('greek-typography', 'warn', typo.map(t => `${t.count} × ${t.name}`).join('; '));
  }

  const tells = countTells(body, lang);
  if (tells.perThousand > MAX_TELLS_PER_THOUSAND) add('machine-phrasing', 'warn', `${tells.total} stock phrases (${tells.perThousand} per 1000 words): ${tells.hits.slice(0, 3).map(h => `${h.label} ×${h.count}`).join(', ')}`);
  else add('machine-phrasing', 'ok', `${tells.total} stock phrase${tells.total === 1 ? '' : 's'} (${tells.perThousand} per 1000 words)`);

  const r = rhythm(body);
  if (!isPost(format) && r.cv !== null && r.cv < 0.3) add('rhythm', 'warn', `sentence lengths vary little (spread ${r.cv}; mean ${r.mean} words)`);

  return { ok: !items.some(i => i.level === 'fail'), items, tells, words, language: LANGUAGE_NAMES[lang] };
}
