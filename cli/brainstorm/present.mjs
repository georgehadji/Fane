// How a brainstorm looks: the recommendation first, then the developed ideas, the plan, and every idea by theme.
// One Markdown renderer for both the CLI (`vane --brainstorm`) and Vane's web UI ({ web: true }). For the web:
//  - model and web text is escaped (Vane renders raw HTML) and its square brackets become parentheses, because
//    Vane's browser code rewrites every "[x]" of an answer (citation chips, or nothing);
//  - links to existing work are <a> tags, and the status is one dimmed quiet() paragraph (image/present.mjs).
import { escapeHtml, failed, failureReason, formatDuration, quiet, stepsDone } from '../image/present.mjs';
import { isWebUrl, safeUrl } from '../write/checks.mjs';
import { TAIL } from './pipeline.mjs';

const NBSP = ' ';
const WORDS = {
  en: { recommendation: 'Recommendation', developed: 'Developed ideas', useCase: 'Use case', steps: 'Steps', risks: 'Risks', success: 'Success looks like', plan: 'Plan', go: 'Go if', fallback: 'Otherwise', insights: 'Insights', watch: 'Watch out', assumption: 'Riskiest assumption', bias: 'Likely bias', uncertainty: 'Still uncertain', questions: 'Open questions', all: 'All ideas', rare: 'rare', exists: 'exists', prior: 'Existing work', scores: 'novelty %n, impact %i, feasibility %f', ideas: 'ideas', themes: 'themes', modes: { speed: 'Speed', balanced: 'Balanced', quality: 'Quality' }, failed: 'The brainstorm could not be finished.' },
  el: { recommendation: 'Πρόταση', developed: 'Αναλυτικά οι καλύτερες ιδέες', useCase: 'Χρήση', steps: 'Βήματα', risks: 'Κίνδυνοι', success: 'Μέτρο επιτυχίας', plan: 'Σχέδιο', go: 'Συνέχεια αν', fallback: 'Αλλιώς', insights: 'Παρατηρήσεις', watch: 'Προσοχή', assumption: 'Η πιο επικίνδυνη υπόθεση', bias: 'Πιθανή προκατάληψη', uncertainty: 'Αβέβαιο ακόμη', questions: 'Ανοιχτά ερωτήματα', all: 'Όλες οι ιδέες', rare: 'σπάνια', exists: 'υπάρχει ήδη', prior: 'Ό,τι υπάρχει ήδη', scores: 'πρωτοτυπία %n, επίδραση %i, εφικτότητα %f', ideas: 'ιδέες', themes: 'θέματα', modes: { speed: 'Speed', balanced: 'Balanced', quality: 'Quality' }, failed: 'Ο καταιγισμός ιδεών δεν ολοκληρώθηκε.' },
};
const words = (lang) => WORDS[lang] || WORDS.en;
const sentence = (s) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const LABELS = {
  en: { prior: 'Looking at what exists', generate: 'Generating ideas', cluster: 'Grouping and scoring', develop: 'Developing the best', synthesis: 'Deciding' },
  el: { prior: 'Τι υπάρχει ήδη', generate: 'Ιδέες', cluster: 'Ομαδοποίηση και βαθμολογία', develop: 'Ανάπτυξη των καλύτερων', synthesis: 'Απόφαση' },
};

export function renderBrainstorm(r, { web = false } = {}) {
  const W = words(r.language);
  const t = web ? (s) => escapeHtml(String(s ?? '').replace(/\[/g, '(').replace(/\]/g, ')')) : (s) => String(s ?? '');
  const link = (title, url) => (web ? `<a href="${escapeHtml(safeUrl(url))}">${t(title)}</a>` : `[${title}](${url})`);
  const joined = (list) => list.map(x => t(x.replace(/[\s.;]+$/, ''))).join('; ');
  const scores = (i) => (i.score != null ? W.scores.replace('%n', i.novelty).replace('%i', i.impact).replace('%f', i.feasibility) : '');
  const byId = new Map(r.ideas.map(i => [i.id, i]));
  const picked = r.picked.map(id => byId.get(id)).filter(Boolean);
  const out = [];

  const s = r.synthesis;
  if (s) {
    out.push(`## ${t(W.recommendation)}`, '', t(s.recommendation));
    const names = s.recommended.map(id => byId.get(id)?.title).filter(Boolean);
    if (names.length) out.push('', `**${names.map(t).join(' · ')}**`);
  }

  const developed = picked.filter(i => i.development);
  if (developed.length) {
    out.push('', `## ${t(W.developed)}`);
    for (const i of developed) {
      const d = i.development;
      out.push('', `### ${t(i.title)}`, '', t(i.description));
      if (scores(i)) out.push('', t(scores(i)));
      if (d.use_case) out.push('', `**${t(W.useCase)}:** ${t(d.use_case)}`);
      if (d.steps.length) out.push('', `**${t(W.steps)}:**`, '', ...d.steps.map((x, n) => `${n + 1}. ${t(x.replace(/^\s*(?:step\s*)?\d+[.:)]\s*/i, ''))}`));
      if (d.risks.length) out.push('', `**${t(W.risks)}:** ${joined(d.risks)}`);
      if (d.success.length) out.push('', `**${t(W.success)}:** ${joined(d.success)}`);
    }
  }

  if (s?.plan.length) out.push('', `## ${t(W.plan)}`, '', ...s.plan.map((p, n) => `${n + 1}. ${p.when ? `**${t(p.when)}:** ` : ''}${[p.action, p.go_if && `${W.go}: ${p.go_if}`, p.fallback && `${W.fallback}: ${p.fallback}`].filter(Boolean).map(x => t(sentence(x))).join(' ')}`));
  if (s?.insights.length) out.push('', `## ${t(W.insights)}`, '', ...s.insights.map(x => `- ${t(x)}`));
  const watch = s ? [[W.assumption, s.riskiest_assumption], [W.bias, s.likely_bias], [W.uncertainty, s.uncertainty]].filter(([, v]) => v) : [];
  if (watch.length) out.push('', `## ${t(W.watch)}`, '', ...watch.map(([k, v]) => `- **${t(k)}:** ${t(v)}`));
  if (s?.open_questions.length) out.push('', `## ${t(W.questions)}`, '', ...s.open_questions.map(x => `- ${t(x)}`));

  out.push('', `## ${t(W.all)}`);
  for (const theme of r.themes) {
    if (theme.theme) out.push('', `### ${t(theme.theme)}`);
    out.push('');
    for (const i of [...theme.ids.map(id => byId.get(id)).filter(Boolean)].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) {
      // no bare score: the order already ranks them, and "(5.4)" has no scale a reader knows
      const tags = [i.probability != null && i.probability < TAIL ? W.rare : '', i.exists ? `${W.exists}: ${i.exists.title}` : ''].filter(Boolean);
      out.push(`- **${t(i.title)}**${tags.length ? ` (${tags.map(t).join(', ')})` : ''}: ${t(i.description)}`);
    }
  }

  const prior = (r.prior || []).filter(p => isWebUrl(p.url));
  if (prior.length) out.push('', `## ${t(W.prior)}`, '', ...prior.map(p => `- ${link(p.title, p.url)}`));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The web answer: the brainstorm, then a dimmed status line (counts, cost, time, mode, notes).
export function renderBrainstormResult(r) {
  const W = words(r.language);
  const summary = [
    `${r.ideas.length}${NBSP}${W.ideas}`,
    r.themes.filter(x => x.theme).length ? `${r.themes.filter(x => x.theme).length}${NBSP}${W.themes}` : null,
    r.cost ? `≈${NBSP}$${r.cost.toFixed(3)}` : null,
    r.ms ? formatDuration(r.ms).replace(' ', NBSP) : null,
    W.modes[r.mode] || r.mode,
  ].filter(Boolean).join(' · ');
  return `${renderBrainstorm(r, { web: true })}\n\n${quiet([escapeHtml(summary), ...r.degraded.slice(0, 5).map(escapeHtml)])}`;
}

// While it runs: the phase and the idea titles so far.
export function renderBrainstormProgress(state) {
  const L = LABELS[state.lang] || LABELS.en;
  const done = [...new Set(state.done.map(p => L[p]).filter(Boolean))];
  const titles = (state.ideas || []).map(i => `- ${escapeHtml(i.title.replace(/[[\]]/g, ''))}`).join('\n');
  return `${titles ? `${titles}\n\n` : ''}${quiet([escapeHtml(`${L[state.running] || state.running || ''}…`), stepsDone(done.length, state.lang)])}`;
}

export function renderBrainstormFailure(result, lang = 'en') {
  return failed(escapeHtml(words(lang).failed), escapeHtml(failureReason(result)));
}
