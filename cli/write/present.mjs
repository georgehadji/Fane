// How an article looks in Vane's web UI: Markdown for the article, one small dimmed status
// paragraph (the same quiet() the image answers use) for progress, cost, time and warnings.
// Pure functions. Status words are in the language of the article, so a Greek request gets
// Greek status lines. Everything that comes from a model or a web page is escaped or cleaned:
// Vane renders raw HTML in answers.
import { escapeHtml, failed, failureReason, formatDuration, quiet, stepsDone } from '../image/present.mjs';
import { linkCitations, renumber, sourcesSection } from './checks.mjs';
import { POSTS } from '../core/formats.mjs';

const NBSP = ' ';

const LABELS = {
  en: { rewrite: 'Trimming to the length', edit: 'Editing the article', sources: 'Researching sources', queries: 'Writing search queries', outline: 'Planning the outline', draft: 'Writing the draft', factcheck: 'Checking the facts', critique: 'Reviewing the argument', revise: 'Revising', polish: 'Polishing', style: 'Editing the style', copy: 'Copy editing', audit: 'Final check' },
  el: { rewrite: 'Περικοπή στο ζητούμενο μήκος', edit: 'Επεξεργασία του κειμένου', sources: 'Αναζήτηση πηγών', queries: 'Διατύπωση αναζητήσεων', outline: 'Σχεδιασμός δομής', draft: 'Συγγραφή του κειμένου', factcheck: 'Έλεγχος γεγονότων', critique: 'Κριτική ανάγνωση', revise: 'Αναθεώρηση', polish: 'Επιμέλεια', style: 'Επιμέλεια ύφους', copy: 'Γλωσσική επιμέλεια', audit: 'Τελικός έλεγχος' },
};
const WORDS = {
  en: { words: 'words', sources: 'sources', source: 'source', draft: 'Draft. Checking and editing next…', modes: { speed: 'Speed', balanced: 'Balanced', quality: 'Quality' } },
  el: { words: 'λέξεις', sources: 'πηγές', source: 'πηγή', draft: 'Πρώτη μορφή. Ακολουθεί έλεγχος και επιμέλεια…', modes: { speed: 'Speed', balanced: 'Balanced', quality: 'Quality' } },
};
const words = (lang) => WORDS[lang] || WORDS.en;
const labels = (lang) => LABELS[lang] || LABELS.en;

// Model text may carry HTML (or a page may have talked it into writing some): tags are removed,
// the Markdown stays. Repeated until nothing changes: one pass turned "<<img …>img onerror=…>" into a tag.
export function cleanMarkdown(text) {
  let s = String(text || ''), prev;
  do { prev = s; s = s.replace(/<(?=[a-zA-Z/!?])[^>]*>/g, ''); } while (s !== prev);
  return s;
}

// What the user sees while the pipeline runs. `state`: { lang, phases: [{ phase, status }],
// running: phase | null, draft: { text, sources } | null }. Once a draft exists it is shown, with
// the sources list, above the status line.
export function renderArticleProgress(state) {
  const lang = state.lang || 'en';
  const L = labels(lang);
  const done = (state.phases || []).filter(p => p.status !== 'running' && L[p.phase]).map(p => L[p.phase]);
  const current = state.draft ? words(lang).draft : state.running ? `${L[state.running] || state.running}…` : '';
  const status = quiet([escapeHtml(current), stepsDone(new Set(done).size, lang)]);
  if (!state.draft) return status;
  const { text, used } = renumber(cleanMarkdown(state.draft.text), state.draft.sources);
  return `${linkCitations(text, used).trimEnd()}${sourcesSection(used, lang, { html: true }).trimEnd()}\n\n${status}`;
}

// The finished article and one status paragraph: size, sources, cost, time, mode, then what went
// wrong or was weak (degraded phases, failed or weak checks), each on its own line.
export function renderArticleResult(r) {
  const lang = r.language || 'en';
  const W = words(lang);
  const summary = [
    `${r.words}${NBSP}${W.words}`,
    `${r.sources.length}${NBSP}${r.sources.length === 1 ? W.source : W.sources}`,
    r.cost ? `≈${NBSP}$${r.cost.toFixed(3)}` : null,
    r.ms ? formatDuration(r.ms).replace(' ', NBSP) : null,
    W.modes[r.mode] || r.mode,
  ].filter(Boolean).join(' · ');
  const notes = [...new Set([...r.degraded, ...r.checks.items.filter(i => i.level !== 'ok').map(i => `${i.name}: ${i.detail}`)])].slice(0, 6);
  // r.article ends with the Markdown sources list; the web answer writes its own, with HTML links
  const [body] = cleanMarkdown(r.article).split(/\n\n(?=## (?:Sources|Πηγές)\n)/);
  return `${linkCitations(body, r.sources).trimEnd()}${sourcesSection(r.sources, lang, { html: true }).trimEnd()}\n\n${quiet([escapeHtml(summary), ...notes.map(n => escapeHtml(n))])}`;
}

const POST_WORDS = {
  en: { comment: 'First comment', chars: 'characters', fold: 'shown before “see more”', copy: 'Post it as it is; put the sources in the first comment.' },
  el: { comment: 'Πρώτο σχόλιο', chars: 'χαρακτήρες', fold: 'φαίνονται πριν από το «see more»', copy: 'Δημοσιεύστε το όπως είναι· οι πηγές μπαίνουν στο πρώτο σχόλιο.' },
};

// A finished social post: the post as it will be published (no citation markers, no Markdown of ours), then the
// first comment with the sources written out, then the status paragraph with the length against the platform's fold.
export function renderPostResult(r) {
  const lang = r.language || 'en';
  const W = words(lang), P = POST_WORDS[lang] || POST_WORDS.en, p = POSTS[r.format];
  const chars = [...r.post].length;
  const hook = [...(r.post.split(/\n/).find(l => l.trim()) || '')].length;
  const summary = [
    `${p.name}`,
    `${chars}${NBSP}${P.chars}`,
    `${Math.min(hook, p.foldChars)}${NBSP}${P.fold}`,
    `${r.sources.length}${NBSP}${r.sources.length === 1 ? W.source : W.sources}`,
    r.cost ? `≈${NBSP}$${r.cost.toFixed(3)}` : null,
    r.ms ? formatDuration(r.ms).replace(' ', NBSP) : null,
    W.modes[r.mode] || r.mode,
  ].filter(Boolean).join(' · ');
  const notes = [...new Set([...r.degraded, ...r.checks.items.filter(i => i.level !== 'ok').map(i => `${i.name}: ${i.detail}`)])].slice(0, 6);
  // Markdown would turn a model's "**" or "1." into formatting the platform will not show, so the post is escaped
  // as text, one paragraph per blank-line block, line breaks kept
  const paragraphs = cleanMarkdown(r.post).split(/\n{2,}/).map(par => escapeHtml(par.trim()).replace(/\n/g, '<br>')).filter(Boolean);
  const post = paragraphs.map(par => `<p>${par}</p>`).join('\n');
  // the comment as it is pasted, with the URLs written out: copying linked titles from the page loses the links
  const comment = r.comment ? `\n\n**${P.comment}**\n\n<p>${escapeHtml(r.comment).replace(/\n/g, '<br>')}</p>` : '';
  return `${post}${comment.trimEnd()}\n\n${quiet([escapeHtml(summary), escapeHtml(P.copy), ...notes.map(n => escapeHtml(n))])}`;
}

// A run that produced no article.
export function renderArticleFailure(result, lang = 'en') {
  const head = result.post ? (lang === 'el' ? 'Δεν μπόρεσα να γράψω την ανάρτηση.' : 'The post could not be written.')
    : lang === 'el' ? (result.edit ? 'Δεν μπόρεσα να αλλάξω το άρθρο.' : 'Δεν μπόρεσα να γράψω το άρθρο.') : result.edit ? 'The article could not be changed.' : 'The article could not be written.';
  return failed(escapeHtml(head), escapeHtml(failureReason(result)));
}
