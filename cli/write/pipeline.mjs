// Article pipeline, after reasoner's article method (ARTICLE_METHOD_SPECIFICATION.md):
//   sources -> outline -> draft -> fact-check -> critique -> revise -> style/copy -> audit.
// A social post (`format`, formats.mjs) runs the same pipeline with fewer phases (POST_PHASES) and a post prompt.
// Which phases run depends on the Vane mode (models.mjs PHASES). Sources come from Vane's own
// research (`retrieve`, injected). Everything that talks to a model goes through llm.mjs, which
// rejects cut-off, empty and "thinking" answers and walks the role's fallback chain.
// Dependencies are injected, so the pipeline is tested with fakes. Failures are returned as
// values ({ ok: false, error }); a phase that fails after the draft is skipped and listed in
// `degraded`, so a weakened run is never presented as a clean one.
import { checkCitations, firstComment, renumber, runChecks, sourcesSection, stripCitations } from './checks.mjs';
import { clampPostWords, isPost } from '../core/formats.mjs';
import { AUDIT_DIMENSIONS, MIN_CLAIM_SUPPORT, auditResult, claimLedger, claimSupportRatio } from './gate.mjs';
import { countTells, detectLanguage, repairFinalNu, repairHomoglyphs, wordCount } from '../core/language.mjs';
import { createRoleCaller, noteOf, statusOf } from './llm.mjs';
import { DEFAULT_MODE, MODES, PHASES, POST_PHASES, chainsFor, clampWords, tokensFor } from './models.mjs';
import { postEditRule, prompts } from './prompts.mjs';

// The passes that write the whole text back; on a post each gets the shape it must keep.
const EDITORS = new Set(['revise', 'polish', 'style', 'copy', 'rewrite']);

export const MAX_SOURCES = 16;
export const THIN_SOURCES = 4;
// English queries added to a non-English topic. One: each query is a full Vane research (three searches
// and a page of progress in the answer), and in the first live run four of them took minutes.
export const EXTRA_QUERIES = 1;
// A text more than a quarter over the target is cut back by one extra call (a live Quality run: draft 543 words,
// after revise 813, after the audit's retry 899, for a target of 500).
export const MAX_OVER = 1.25;
// A trim goes on (at most TRIM_PASSES calls) until the text is within the cap the editing prompts state.
export const LENGTH_CAP = 1.1;
export const TRIM_PASSES = 2;

const pct = (x) => `${Math.round(x * 100)}%`;
const titleOf = (text) => /^\s*#\s+(.+)$/m.exec(text)?.[1].trim() || '';

class Stop extends Error {}

export function createArticlePipeline({ client, retrieve, log = () => {}, now = Date.now }) {
  const call = createRoleCaller({ client, log });

  // format: 'article', or a platform of formats.mjs POSTS ('linkedin', 'facebook') for a social post.
  return async function writeArticle({ topic, mode = DEFAULT_MODE, lang, words, models, chains, prices, format = 'article', onProgress = () => {} }) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}"`);
    const post = isPost(format);
    if (!post && format !== 'article') throw new Error(`unknown format "${format}"`);
    const t0 = now();
    const today = new Date(t0).toISOString().slice(0, 10); // prompts give figures their year and prefer new sources
    lang ||= detectLanguage(topic);
    words = post ? clampPostWords(words, format) : clampWords(words);
    chains ||= chainsFor(models);
    const plan = (post ? POST_PHASES : PHASES)[mode];
    const phases = [], degraded = [];
    let cost = 0, calls = 0, repaired = 0;
    const emit = (e) => { try { onProgress(e); } catch { /* a throwing listener must not stop the article */ } };

    // One model call for a role. A fatal error (bad key, no credits) stops the whole run.
    async function step(role, ctx) {
      emit({ phase: role, status: 'running' });
      const started = now();
      // an editor writes the whole article back, which may already be longer than the target
      const size = Math.max(words, ctx.article ? wordCount(ctx.article) : 0);
      const prompt = prompts[role]({ topic, lang, words, today, format, ...ctx });
      if (post && EDITORS.has(role)) prompt.user += postEditRule(format);
      const r = await call(role, prompt, { chain: chains[role] || chains.draft, maxTokens: tokensFor(role, size, lang), prices });
      calls += r.attempts.length;
      cost += r.cost;
      const rec = { phase: role, model: r.model || null, status: statusOf(r), ms: now() - started, note: noteOf(r) };
      phases.push(rec);
      emit({ ...rec, status: rec.status });
      if (r.fatal) throw Object.assign(new Stop(r.errors[0] || 'the provider refused the request'), { status: r.status });
      return r;
    }

    // Edited text replaces the text only if it is plausibly the whole article again.
    const refuse = (prev, next, shrink = 0.6) => {
      if (wordCount(next) < wordCount(prev) * shrink) return 'much shorter than its input';
      if (/^\s*#\s/m.test(prev) && !/^\s*#\s/m.test(next)) return 'lost the title';
      const before = checkCitations(prev, sources).cited;
      if (before >= 3 && checkCitations(next, sources).cited < before * 0.5) return 'dropped most citations';
      return null;
    };
    const fix = (text) => {
      if (lang !== 'el') return text;
      const r = repairHomoglyphs(text);
      const nu = repairFinalNu(r.text);
      repaired += r.fixed.length + nu.fixed.length;
      return nu.text;
    };
    // Run an editing role and keep its text when it passes `refuse`.
    async function edit(role, ctx) {
      const r = await step(role, { article: body, sources, ...ctx });
      if (!r.ok) { degraded.push(`${role} failed (${r.errors.at(-1) || 'no answer'}): that pass was skipped`); return false; }
      phases.at(-1).words = wordCount(r.text); // where a text grows or shrinks shows in the report
      const why = refuse(body, r.text);
      if (why) {
        phases.at(-1).status = 'rejected';
        phases.at(-1).note = why;
        degraded.push(`${role} was rejected (${why}): the previous text was kept`);
        return false;
      }
      body = fix(r.text);
      await trim();
      return true;
    }
    // Cut a text that ran over the target back toward it, again while it is still over the editors' cap
    // (one live trim went from 785 to 651 words for 500). Each result must be shorter and still an article.
    async function trim() {
      if (wordCount(body) <= words * MAX_OVER) return;
      for (let pass = 0; pass < TRIM_PASSES && wordCount(body) > words * LENGTH_CAP; pass++) {
        const before = wordCount(body);
        const r = await step('rewrite', { article: body, sources, instruction: `Cut it to about ${words} words: it is ${before} words, so remove about ${before - words}. Drop repetition and the least important detail first, then merge or drop whole paragraphs; shortening sentences alone will not get there. Keep the thesis, the title, the headings and the claims that carry the argument, with their [n] citations.` });
        const why = !r.ok ? (r.errors.at(-1) || 'no answer') : wordCount(r.text) >= before ? 'not shorter' : refuse(body, r.text, 0.4);
        if (why) {
          phases.at(-1).status = r.ok ? 'rejected' : 'failed';
          degraded.push(`trimming from ${before} words to the target of ${words} failed (${why}): the longer text was kept`);
          return;
        }
        phases.at(-1).words = wordCount(r.text);
        body = fix(r.text);
      }
    }

    let sources = [], body = '';
    try {
      // 1. Sources: the topic, plus English queries when the topic is not English (most sources are).
      emit({ phase: 'sources', status: 'running' });
      let queries = [topic];
      if (lang !== 'en' && plan.includes('queries')) {
        const q = await step('queries', {});
        if (q.ok) queries = [topic, ...(Array.isArray(q.data.queries) ? q.data.queries.filter(s => typeof s === 'string' && s.trim()).slice(0, EXTRA_QUERIES) : [])];
        else degraded.push('English search queries failed: searched with the topic only');
        emit({ phase: 'sources', status: 'running' }); // the query step had its own status; the searches are next
      }
      const found = await Promise.allSettled(queries.map(q => retrieve(q)));
      const seen = new Set();
      for (const f of found) for (const s of f.status === 'fulfilled' ? f.value : []) if (s?.url && !seen.has(s.url)) { seen.add(s.url); sources.push({ title: s.title || s.url, url: s.url, content: s.content || '' }); }
      sources = sources.slice(0, MAX_SOURCES);
      phases.push({ phase: 'sources', model: null, status: sources.length ? 'ok' : 'failed', ms: 0, note: `${sources.length} sources` });
      emit({ phase: 'sources', status: 'done', note: `${sources.length} sources` });
      if (!sources.length) {
        const why = found.find(f => f.status === 'rejected')?.reason?.message;
        return { ok: false, error: `no sources found for this topic${why ? ` (${why})` : ''}; an article without sources would be unchecked`, phases, language: lang, mode, calls, cost };
      }
      if (sources.length < THIN_SOURCES) degraded.push(`only ${sources.length} source${sources.length === 1 ? '' : 's'} found: thinly sourced`);

      // 2. Outline (optional: without it the draft is written from the sources alone).
      let outline = null;
      if (plan.includes('outline')) {
        const o = await step('outline', { sources });
        if (o.ok && Array.isArray(o.data.sections)) outline = o.data;
        else degraded.push('the outline failed: the draft was written without a plan');
      }

      // 3. Draft (required).
      const d = await step('draft', { sources, outline });
      if (!d.ok) return { ok: false, error: `the draft failed: ${d.errors.join('; ')}`, phases, language: lang, mode, calls, cost, sources };
      body = fix(d.text);
      phases.at(-1).words = wordCount(body);
      await trim();
      emit({ phase: 'draft', status: 'preview', text: body, sources }); // lets a UI show the draft while the checks and edits run

      // 4. Fact-check (a ledger of claims against their cited sources) and the structural critique. Both read
      // the same draft and neither needs the other, so they run at the same time. A Stop in one waits for the other:
      // it is paid for, and its late progress would overwrite the answer.
      const both = await Promise.allSettled([
        plan.includes('factcheck') ? step('factcheck', { article: body, sources }) : null,
        plan.includes('critique') ? step('critique', { article: body }) : null,
      ]);
      const stopped = both.find(s => s.status === 'rejected');
      if (stopped) throw stopped.reason;
      const [f, c] = both.map(s => s.value);
      let ledger = [], claimSupport = null;
      if (f) {
        if (f.ok) {
          ledger = claimLedger(f.data);
          claimSupport = claimSupportRatio(ledger);
          if (claimSupport !== null && claimSupport < MIN_CLAIM_SUPPORT) degraded.push(`thinly sourced: only ${pct(claimSupport)} of the ${ledger.length} checked claims are supported by their sources`);
        } else degraded.push('the fact-check failed: claims were not verified by a model');
      }

      // 5. The developmental edit that acts on the critique and on the failed claims.
      let critique = null;
      if (c) {
        if (c.ok) critique = c.data;
        else degraded.push('the critique failed: no structural review');
      }
      const failedClaims = ledger.some(c => c.verdict !== 'supported');
      if (plan.includes('revise') && (critique || failedClaims)) await edit('revise', { critique, ledger, outline });

      // 6. Style and copy edit (one merged call on Balanced).
      const tellsReport = () => countTells(body, lang).hits.map(h => `${h.label} ×${h.count}`).join(', ');
      for (const role of ['polish', 'style', 'copy']) if (plan.includes(role)) await edit(role, { tellsReport: tellsReport() });

      // 7. Final audit, with one retry (revise, style, copy, audit) when it fails.
      let audit = null;
      const runAudit = async () => {
        const a = await step('audit', { article: body, ledger });
        if (!a.ok) { degraded.push('the final audit failed: no quality score'); return null; }
        return { ...auditResult(a.data.scores), scores: Object.fromEntries(AUDIT_DIMENSIONS.map(k => [k, a.data.scores?.[k] ?? null])), issues: Array.isArray(a.data.issues) ? a.data.issues.slice(0, 8) : [] };
      };
      if (plan.includes('audit')) {
        audit = await runAudit();
        if (audit && !audit.passes) {
          audit.retried = true;
          for (const role of ['revise', 'style', 'copy']) await edit(role, { critique: { audit_issues: audit.issues }, ledger, tellsReport: tellsReport() });
          const second = await runAudit();
          if (second) audit = { ...second, retried: true };
          if (audit && !audit.passes) degraded.push(`the final audit failed twice (${audit.failures.join('; ') || `score ${audit.score}`}): published as is`);
        }
      }

      // 8. Finish: cited sources numbered 1..n in order of appearance, a sources list written by code, checks.
      const raw = checkCitations(body, sources);
      if (raw.invalid.length) degraded.push(`removed citations to sources that do not exist: ${raw.invalid.map(n => `[${n}]`).join(' ')}`);
      const { text, used } = renumber(body, sources);
      // with no citation at all `used` is empty, and the citation check must still see the sources to fail
      const checks = runChecks(text, { lang, sources: used.length ? used : sources, targetWords: words, format });
      for (const i of checks.items) if (i.level === 'fail') degraded.push(`check "${i.name}" failed: ${i.detail}`);
      emit({ phase: 'done', status: 'done' });
      // a post is published without its [n] markers, and its sources go in the first comment
      const published = post ? { post: stripCitations(text), comment: firstComment(used, lang) } : null;
      return {
        ok: true,
        format,
        article: post ? `${published.post}${published.comment ? `\n\n---\n\n${published.comment}` : ''}\n` : text.trimEnd() + sourcesSection(used, lang),
        ...published,
        title: post ? '' : titleOf(text),
        language: lang,
        mode,
        words: post ? wordCount(published.post) : checks.words,
        targetWords: words,
        sources: used,
        phases,
        degraded,
        checks,
        ledger,
        claimSupport,
        audit,
        repaired,
        calls,
        cost,
        ms: now() - t0,
      };
    } catch (err) {
      if (err instanceof Stop) return { ok: false, fatal: true, status: err.status, error: err.message, phases, language: lang, mode, calls, cost };
      throw err;
    }
  };
}
