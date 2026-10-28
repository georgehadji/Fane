// How a coding run looks in Vane's web UI: each file in a fenced block (Vane renders those with its own code view,
// language and copy button), the review in plain lists, and one small dimmed status paragraph (image/present.mjs
// quiet()). Pure functions. Rules from Vane's renderer:
//  - Vane rewrites every "[x]" of an answer (citation chips when the answer has sources, "[1]" deleted when it has
//    none), which breaks code such as a[0] or [a, b]; patch-code-chat skips that for answers that contain
//    CODE_ANSWER_MARKER, so every answer here carries it (patches/lib/vane.js has the same string, a test checks);
//  - inline `code` shows its backticks literally, and a path in a Markdown heading can turn "__init__" into bold,
//    so paths are HTML headings with escaped text;
//  - everything from a model or a web page outside a code block is escaped (Vane renders raw HTML).
import { escapeHtml, failed, failureReason, formatDuration, quiet, stepsDone, tagged } from '../image/present.mjs';
import { isWebUrl, safeUrl } from '../write/checks.mjs';
import { fenceFor, languageOf } from './files.mjs';

export const CODE_ANSWER_MARKER = '<!--fane:code-answer-->';
export const codeTagged = (markdown) => tagged(`${markdown}\n\n${CODE_ANSWER_MARKER}`);

const NBSP = ' ';

const LABELS = {
  en: { docs: 'Reading documentation', spec: 'Planning the files', generate: 'Writing the code', cve: 'Looking up known vulnerabilities', review: 'Reviewing the code', fix: 'Applying the fixes', tests: 'Writing the tests' },
  el: { docs: 'Ανάγνωση τεκμηρίωσης', spec: 'Σχεδιασμός των αρχείων', generate: 'Συγγραφή του κώδικα', cve: 'Αναζήτηση γνωστών ευπαθειών', review: 'Αξιολόγηση του κώδικα', fix: 'Διορθώσεις', tests: 'Συγγραφή των ελέγχων' },
};
const WORDS = {
  en: { files: 'files', file: 'file', tests: 'Tests', testFiles: 'tests', review: 'Review', fixed: 'Fixed', open: 'Not fixed', approved: 'The review found no critical or high issue.', syntax: 'syntax', ok: 'parses', error: 'does not parse', unchecked: 'not checked', refs: 'References', draft: 'First version. Review and tests next…', modes: { speed: 'Speed', balanced: 'Balanced', quality: 'Quality' }, failed: 'The code could not be written.' },
  el: { files: 'αρχεία', file: 'αρχείο', tests: 'Έλεγχοι', testFiles: 'έλεγχοι', review: 'Αξιολόγηση', fixed: 'Διορθώθηκαν', open: 'Δεν διορθώθηκαν', approved: 'Η αξιολόγηση δεν βρήκε σοβαρό πρόβλημα.', syntax: 'σύνταξη', ok: 'σωστή', error: 'λάθος', unchecked: 'χωρίς έλεγχο', refs: 'Πηγές', draft: 'Πρώτη μορφή. Ακολουθούν αξιολόγηση και έλεγχοι…', modes: { speed: 'Speed', balanced: 'Balanced', quality: 'Quality' }, failed: 'Δεν μπόρεσα να γράψω τον κώδικα.' },
};
const words = (lang) => WORDS[lang] || WORDS.en;

export function codeBlock(file) {
  const fence = fenceFor(file.content);
  return `<h4>${escapeHtml(file.path)}</h4>\n\n${fence}${languageOf(file.path)}\n${file.content.replace(/\n$/, '')}\n${fence}`;
}

const files = (list) => list.map(codeBlock).join('\n\n');

// While the pipeline runs: the status line, and the files as soon as they are written.
export function renderCodeProgress(state) {
  const lang = state.lang || 'en';
  const L = LABELS[lang] || LABELS.en, W = words(lang);
  const done = [...new Set((state.phases || []).filter(p => p.status !== 'running' && L[p.phase]).map(p => L[p.phase]))];
  const current = state.files ? W.draft : state.running ? `${L[state.running] || state.running}…` : '';
  const status = quiet([escapeHtml(current), stepsDone(done.length, lang)]);
  return state.files?.length ? `${files(state.files)}\n\n${status}` : status;
}

const issueList = (issues) => `<ul>${issues.map(i => `<li>${escapeHtml(`${i.file || i.named || '?'} (${i.severity}): ${i.issue}`)}</li>`).join('')}</ul>`;

export function renderCodeResult(r) {
  const lang = r.language || 'en';
  const W = words(lang);
  const parts = [];
  if (r.spec.summary) parts.push(`<p>${escapeHtml(r.spec.summary)}</p>`);
  parts.push(files(r.files));
  if (r.tests.length) parts.push(`<h3>${escapeHtml(W.tests)}</h3>`, files(r.tests));
  parts.push(codeBlock({ path: 'README.md', content: r.readme }));
  if (r.review) {
    const review = [`<h3>${escapeHtml(W.review)}</h3>`];
    if (r.review.posture) review.push(`<p>${escapeHtml(r.review.posture)}</p>`);
    if (r.fixes.length) review.push(`<p>${escapeHtml(W.fixed)}:</p>`, issueList(r.fixes.flatMap(f => f.issues)));
    if (r.open.length) review.push(`<p>${escapeHtml(W.open)}:</p>`, issueList(r.open));
    if (!r.fixes.length && !r.open.length) review.push(`<p>${escapeHtml(W.approved)}</p>`);
    parts.push(review.join('\n'));
  }
  const refs = [...r.docs, ...r.cve].filter(s => isWebUrl(s.url));
  if (refs.length) parts.push(`<p>${escapeHtml(W.refs)}:<br>${refs.map(s => `<a href="${escapeHtml(safeUrl(s.url))}">${escapeHtml(s.title)}</a>`).join('<br>')}</p>`);

  const all = [...r.files, ...r.tests];
  const counts = { ok: 0, error: 0, unchecked: 0 };
  for (const f of all) counts[f.syntax?.status || 'unchecked']++;
  const summary = [
    `${r.files.length}${NBSP}${r.files.length === 1 ? W.file : W.files}`,
    r.tests.length ? `${r.tests.length}${NBSP}${W.testFiles}` : null,
    `${W.syntax}: ${['ok', 'error', 'unchecked'].filter(k => counts[k]).map(k => `${counts[k]}${NBSP}${W[k]}`).join(', ')}`,
    r.cost ? `≈${NBSP}$${r.cost.toFixed(3)}` : null,
    r.ms ? formatDuration(r.ms).replace(' ', NBSP) : null,
    W.modes[r.mode] || r.mode,
  ].filter(Boolean).join(' · ');
  const notes = [...new Set([...r.degraded, ...r.checks.filter(c => c.level === 'warn').map(c => c.detail)])].slice(0, 6);
  parts.push(quiet([escapeHtml(summary), ...notes.map(n => escapeHtml(n))]));
  return parts.join('\n\n');
}

export function renderCodeFailure(result, lang = 'en') {
  return failed(escapeHtml(words(lang).failed), escapeHtml(failureReason(result)));
}
