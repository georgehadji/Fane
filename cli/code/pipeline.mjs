// Coding pipeline, after reasoner's coding method (src/reasoner/application/flows/coding.py, coding_phases.py):
//   docs -> spec -> generate (one call per file, CONCURRENCY at a time) -> syntax check -> CVE search -> review
//   -> fix -> tests, then a README written by code.
// Which phases run depends on the Vane mode (models.mjs CODE_PHASES). Documentation and vulnerability notes come
// from Vane's own research (`retrieve`, injected). Model calls go through write/llm.mjs, which rejects cut-off,
// empty and "thinking" answers and walks the role's fallback chain. `checkSyntax` (syntax.mjs) parses files without
// running them; nothing generated is ever executed. Failures are returned as values; a phase that fails after the
// files exist is skipped and listed in `degraded`, so a weakened run is never presented as a clean one.
import { createRoleCaller, noteOf, statusOf } from '../write/llm.mjs';
import { LANGUAGE_NAMES, detectLanguage } from '../core/language.mjs';
import { DEFAULT_MODE, MODES } from '../write/models.mjs';
import { MAX_FILE_CHARS, extractCode, fileChecks, parseFiles, safePath, sameFile } from './files.mjs';
import { CODE_JSON_ROLES, CODE_PHASES, CONCURRENCY, MAX_FILES, codeChainsFor, codeTokensFor } from './models.mjs';
import { codePrompts } from './prompts.mjs';

export const MAX_DOCS = 8;
export const MAX_ISSUES = 12;

const strings = (a) => (Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);
const text = (s) => (typeof s === 'string' ? s.trim() : '');

// The model's spec, with every path checked: an unsafe or repeated path is dropped, the list is cut at MAX_FILES.
// -> { spec, dropped: [notes] } | { spec: null }
export function normalizeSpec(data) {
  const dropped = [];
  const files = [];
  for (const f of Array.isArray(data?.files) ? data.files : []) {
    const path = safePath(f?.path);
    if (!path) { dropped.push(`the spec named an unusable path (${String(f?.path ?? '').slice(0, 60)}): skipped`); continue; }
    if (files.some(x => sameFile(x.path, path)) || /^readme(?:\.md)?$/i.test(path)) continue;
    files.push({ path, purpose: text(f.purpose) || path, exports: strings(f.exports), imports: strings(f.imports) });
  }
  if (!files.length) return { spec: null, dropped };
  if (files.length > MAX_FILES) dropped.push(`the spec listed ${files.length} files: the first ${MAX_FILES} were written`);
  return {
    spec: {
      language: text(data.language) || 'unknown',
      framework: text(data.framework) && !/^(?:null|none|n\/a)$/i.test(text(data.framework)) ? text(data.framework) : '',
      summary: text(data.summary),
      files: files.slice(0, MAX_FILES),
      dependencies: strings(data.dependencies),
      error_strategy: text(data.error_strategy),
      security_notes: strings(data.security_notes),
      test_strategy: text(data.test_strategy),
      test_command: text(data.test_command),
      setup: text(data.setup),
      run: text(data.run),
    },
    dropped,
  };
}

// The review's findings, each pinned to a file of the project where it names one.
export function normalizeReview(data, files) {
  const known = new Set(files.map(f => f.path));
  const list = (key, severity) => (Array.isArray(data?.[key]) ? data[key] : [])
    .filter(i => text(i?.issue))
    .slice(0, MAX_ISSUES)
    .map(i => { const p = safePath(i.file); return { severity, file: p && known.has(p) ? p : null, named: text(i.file), issue: text(i.issue), fix: text(i.fix) }; });
  const critical = list('critical', 'critical'), high = list('high', 'high'), medium = list('medium', 'medium');
  const verdict = /approved/i.test(text(data?.verdict)) && !critical.length && !high.length ? 'approved' : 'needs_fixes';
  return { critical, high, medium, verdict, posture: text(data?.security_posture) };
}

// After one item throws (a 402 Stop), the other workers take no new item: they would only make more paid calls.
// The throw waits for the items already running: they are paid for, and their late progress would overwrite the answer.
export async function mapLimited(items, n, fn) {
  const out = new Array(items.length);
  let next = 0, failed = false;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (err) { failed = true; throw err; }
    }
  }));
  const rejected = settled.find(s => s.status === 'rejected');
  if (rejected) throw rejected.reason;
  return out;
}

const README_WORDS = {
  en: { files: 'Files', tests: 'Tests', setup: 'Setup', run: 'Run', review: 'Review', fixed: 'Fixed after the review', open: 'Not fixed', approved: 'The review found no critical or high issue.', unreviewed: 'Not reviewed (Speed mode).', from: 'Written by Fane (`vane --code`, %s) from this request:', test: 'test' },
  el: { files: 'Αρχεία', tests: 'Έλεγχοι', setup: 'Εγκατάσταση', run: 'Χρήση', review: 'Αξιολόγηση', fixed: 'Διορθώθηκαν μετά την αξιολόγηση', open: 'Δεν διορθώθηκαν', approved: 'Η αξιολόγηση δεν βρήκε σοβαρό πρόβλημα.', unreviewed: 'Χωρίς αξιολόγηση (λειτουργία Speed).', from: 'Γράφτηκε από το Fane (`vane --code`, %s) με αυτό το αίτημα:', test: 'έλεγχος' },
};

// README.md, written by code from the spec and the review: no extra model call, and nothing in it is invented.
export function buildReadme({ request, spec, files, tests, review, fixes, open, mode, lang }) {
  const W = README_WORDS[lang] || README_WORDS.en;
  const title = request.length > 90 ? `${request.slice(0, 87).trimEnd()}…` : request;
  const purpose = new Map(spec.files.map(f => [f.path, f.purpose]));
  const out = [`# ${title.replace(/\n/g, ' ')}`, '', spec.summary, '', `## ${W.files}`, ''];
  for (const f of files) out.push(`- \`${f.path}\`: ${purpose.get(f.path) || ''}`);
  for (const t of tests) out.push(`- \`${t.path}\`: ${W.test}`);
  if (spec.dependencies.length || spec.setup) out.push('', `## ${W.setup}`, '', spec.setup || spec.dependencies.join(', '));
  if (spec.run) out.push('', `## ${W.run}`, '', spec.run);
  if (tests.length && spec.test_command) out.push('', `## ${W.tests}`, '', '```', spec.test_command, '```');
  out.push('', `## ${W.review}`, '');
  if (!review) out.push(W.unreviewed);
  else {
    if (review.posture) out.push(review.posture, '');
    if (fixes.length) out.push(`${W.fixed}:`, '', ...fixes.flatMap(f => f.issues.map(i => `- \`${f.path}\` (${i.severity}): ${i.issue}`)), '');
    if (open.length) out.push(`${W.open}:`, '', ...open.map(i => `- ${i.file ? `\`${i.file}\`` : i.named || '?'} (${i.severity}): ${i.issue}`), '');
    if (!fixes.length && !open.length) out.push(W.approved);
  }
  out.push('', '---', '', W.from.replace('%s', mode), '', ...request.split('\n').map(l => `> ${l}`));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const notChecked = async (files) => files.map(f => ({ path: f.path, status: 'unchecked' }));
// A fix is kept only when it is plausibly the whole file again.
function refuse(prev, next) {
  if (!next.trim()) return 'empty';
  if (next.length > MAX_FILE_CHARS) return 'too long';
  if (next.split('\n').length < prev.split('\n').length * 0.5) return 'much shorter than the file it fixes';
  return null;
}

class Stop extends Error {}

export function createCodePipeline({ client, retrieve, checkSyntax = notChecked, log = () => {}, now = Date.now }) {
  const call = createRoleCaller({ client, log });

  return async function writeCode({ request, mode = DEFAULT_MODE, lang, models, chains, prices, onProgress = () => {} }) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}"`);
    const t0 = now();
    const today = new Date(t0).toISOString().slice(0, 10);
    lang = LANGUAGE_NAMES[lang] ? lang : detectLanguage(request);
    chains ||= codeChainsFor(models);
    const plan = CODE_PHASES[mode];
    const phases = [], degraded = [];
    let cost = 0, calls = 0;
    const emit = (e) => { try { onProgress(e); } catch { /* a throwing listener must not stop the run */ } };
    const fail = (error) => ({ ok: false, error, phases, language: lang, mode, calls, cost });

    async function step(role, ctx) {
      emit({ phase: role, status: 'running', file: ctx.file?.path });
      const started = now();
      const r = await call(role, codePrompts[role]({ text: request, lang, today, ...ctx }), {
        chain: chains[role] || chains.generate, maxTokens: codeTokensFor(role), temperature: 0.2, prices, json: CODE_JSON_ROLES.has(role), code: true,
      });
      calls += r.attempts.length;
      cost += r.cost;
      const rec = { phase: role, file: ctx.file?.path, model: r.model || null, status: statusOf(r), ms: now() - started, note: noteOf(r) };
      phases.push(rec);
      emit(rec);
      if (r.fatal) throw Object.assign(new Stop(r.errors[0] || 'the provider refused the request'), { status: r.status });
      return { ...r, rec }; // files run in parallel: phases.at(-1) may be another file's record
    }

    // Vane research: the pages of one query, de-duplicated. A failed search is a note, not the end of the run.
    async function search(phase, query) {
      emit({ phase, status: 'running' });
      let found = [];
      try { found = await retrieve(query); } catch (err) { degraded.push(`the ${phase} search failed (${err.message})`); }
      const seen = new Set(), pages = [];
      for (const s of found || []) if (s?.url && !seen.has(s.url)) { seen.add(s.url); pages.push({ title: s.title || s.url, url: s.url, content: s.content || '' }); }
      phases.push({ phase, model: null, status: pages.length ? 'ok' : 'failed', ms: 0, note: `${pages.length} pages` });
      emit({ phase, status: 'done', note: `${pages.length} pages` });
      return pages.slice(0, MAX_DOCS);
    }

    // Parse results are kept on each file (`syntax`); a checker that throws leaves the files unchecked.
    async function check(files) {
      if (!files.length) return;
      let results = [];
      try { results = await checkSyntax(files); } catch (err) { degraded.push(`the syntax check failed (${err.message})`); }
      for (const f of files) f.syntax = results.find(r => r.path === f.path) || { status: 'unchecked' };
    }

    try {
      // 1. Documentation for the libraries the request involves (reasoner: "Library Research").
      let docs = [];
      if (plan.includes('docs') && retrieve) {
        docs = await search('docs', request);
        if (!docs.length) degraded.push('no documentation pages found: the code was written without references');
      }

      // 2. Spec (required): language, files and their interfaces.
      const s = await step('spec', { docs });
      if (!s.ok) return fail(`the specification failed: ${s.errors.join('; ')}`);
      const { spec, dropped } = normalizeSpec(s.data);
      if (!spec) return fail('the specification named no usable file');
      degraded.push(...dropped);
      emit({ phase: 'spec', status: 'preview', spec });

      // 3. One call per file, a few at a time; a file that fails is reported, never stored as an error text.
      const written = await mapLimited(spec.files, CONCURRENCY, async (file) => {
        const r = await step('generate', { spec, file, docs });
        if (!r.ok) { degraded.push(`${file.path} could not be written (${r.errors.at(-1) || 'no answer'})`); return null; }
        const content = extractCode(r.text);
        if (!content.trim()) { degraded.push(`${file.path}: the answer held no code`); return null; }
        if (content.length > MAX_FILE_CHARS) { degraded.push(`${file.path}: ${content.length} characters, more than ${MAX_FILE_CHARS}: dropped`); return null; }
        return { path: file.path, content, role: 'source' };
      });
      let files = written.filter(Boolean);
      if (!files.length) return fail('no file could be written');
      await check(files);
      emit({ phase: 'generate', status: 'preview', files });

      // 4. Known vulnerabilities of the stack, for the review (Quality).
      let cve = [];
      if (plan.includes('cve') && retrieve) cve = await search('cve', `${spec.language} ${spec.framework} security vulnerabilities CVE`.replace(/\s+/g, ' '));

      // 5. Adversarial review of the whole files.
      let review = null;
      if (plan.includes('review')) {
        const broken = files.filter(f => f.syntax.status === 'error').map(f => ({ path: f.path, detail: f.syntax.detail }));
        const r = await step('review', { spec, files, syntax: broken, cve });
        if (r.ok) review = normalizeReview(r.data, files);
        else degraded.push('the review failed: the code was not reviewed');
      }

      // 6. Fixes: one call per file with a critical or high finding, or that does not parse. A fix that breaks
      // the parse of a file that parsed, or loses most of it, is refused and the earlier file kept.
      const fixes = [], unfixed = new Set();
      if (plan.includes('fix')) {
        const todo = files.map(file => ({
          file,
          issues: [
            ...(review ? [...review.critical, ...review.high].filter(i => i.file === file.path) : []),
            ...(file.syntax.status === 'error' ? [{ severity: 'syntax', file: file.path, issue: `does not parse: ${file.syntax.detail}`, fix: '' }] : []),
          ],
        })).filter(t => t.issues.length);
        const results = await mapLimited(todo, CONCURRENCY, async ({ file, issues }) => {
          const r = await step('fix', { spec, file, issues });
          let why = r.ok ? null : `failed: ${r.errors.at(-1) || 'no answer'}`;
          const next = r.ok ? { ...file, content: extractCode(r.text) } : null;
          if (!why) why = refuse(file.content, next.content);
          if (!why) {
            await check([next]);
            if (file.syntax.status === 'ok' && next.syntax.status === 'error') why = `the fixed file does not parse (${next.syntax.detail})`;
          }
          if (why) {
            if (r.ok) { r.rec.status = 'rejected'; r.rec.note = why; }
            degraded.push(`the fix of ${file.path} was not used (${why}): the earlier file was kept`);
            for (const i of issues) unfixed.add(i);
            return null;
          }
          // a file that did not parse and still does not: the fix is kept for its other changes, the parse is not fixed
          const still = next.syntax.status === 'error' ? issues.filter(i => i.severity === 'syntax') : [];
          for (const i of still) unfixed.add(i);
          const done = issues.filter(i => !still.includes(i));
          if (done.length) fixes.push({ path: file.path, issues: done });
          return next;
        });
        const fixed = new Map(results.filter(Boolean).map(f => [f.path, f]));
        files = files.map(f => fixed.get(f.path) || f);
      }
      const open = review ? [...review.critical, ...review.high].filter(i => !i.file || !plan.includes('fix') || unfixed.has(i)).concat(review.medium) : [];

      // 7. Tests of the final files, with a regression test per finding.
      let tests = [];
      if (plan.includes('tests')) {
        const r = await step('tests', { spec, files, issues: review ? [...review.critical, ...review.high] : [] });
        if (!r.ok) degraded.push(`the tests could not be written (${r.errors.at(-1) || 'no answer'})`);
        else {
          tests = parseFiles(r.text).filter(t => !files.some(f => sameFile(f.path, t.path)) && t.content.length <= MAX_FILE_CHARS).map(t => ({ ...t, role: 'test' }));
          if (!tests.length) degraded.push('the test answer held no usable test file');
          await check(tests);
        }
      }

      // 8. Finish: deterministic checks and a README written by code.
      const checks = fileChecks([...files, ...tests]);
      for (const c of checks) if (c.level === 'fail') degraded.push(`check "${c.name}" failed: ${c.detail}`);
      const readme = buildReadme({ request, spec, files, tests, review, fixes, open, mode, lang });
      emit({ phase: 'done', status: 'done' });
      return { ok: true, request, language: lang, mode, spec, files, tests, readme, review, fixes, open, docs, cve, checks, phases, degraded, calls, cost, ms: now() - t0 };
    } catch (err) {
      if (err instanceof Stop) return { ...fail(err.message), fatal: true, status: err.status };
      throw err;
    }
  };
}
