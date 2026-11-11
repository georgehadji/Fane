// One role call: try each model of the role's chain until one returns something usable.
// "Usable" is checked here, because reasoner's postmortem (docs/plans/article-flow-truncation-remediation.md)
// found a pipeline cannot see these failures on its own and reports a degraded run as a clean one:
//  - finish_reason "length": the answer was cut at max_tokens
//  - empty content (some models return nothing, then work on a retry elsewhere)
//  - the model's reasoning printed as the answer ("Thinking Process: ...")
//  - JSON roles: no parseable JSON object
// Errors 401/402 (bad key, no credits) hit every model alike and stop the chain.
import { FATAL_STATUS, FREE_PREFIX, isFreeModel } from '../image/openrouter.mjs';
import { PHASE, isStopped } from '../core/outcome.mjs';
import { THINKING_LEAK } from './checks.mjs';
import { isJsonRole } from './models.mjs';
import { DEFAULT_REASONING, costCap } from '../core/effort.mjs';

const textOf = (content) => (Array.isArray(content) ? content.map(p => p?.text || '').join('') : String(content ?? '')).trim();
const stripThinking = (s) => s.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
// Code can hold these tags itself (a parser of model output): only a block in front of the answer is reasoning.
const stripLeadingThinking = (s) => s.replace(/^\s*<(think|thinking)>[\s\S]*?<\/\1>/i, '').trim();
const CODE_THINKING_LEAK = /^\s*(?:thinking process|<think>|<thinking>)/i;

export function extractJson(text) {
  const s = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// Some models answer without usage.cost (minimax-m3.1-flash, grok-4.7 in the trial), so an edit on Speed showed
// no cost at all; then the cost is estimated from the token counts and `prices` (USD per million tokens).
export const costOf = (usage, price) => (typeof usage?.cost === 'number' ? usage.cost
  : price ? ((usage?.prompt_tokens || 0) * price.in + (usage?.completion_tokens || 0) * price.out) / 1e6 : 0);

// How a finished call shows in a pipeline's phase record: 'ok', 'fallback' (a later model answered) or 'failed',
// and the problems of the models that did not answer.
export const statusOf = (r) => (r.ok ? (r.fallback ? PHASE.fallback : PHASE.ok) : PHASE.failed);
export const noteOf = (r) => (r.ok ? (r.fallback ? r.attempts.filter(a => a.problem).map(a => `${a.model}: ${a.problem}`).join('; ') : '') : r.errors.join('; '));

// -> { ok: true, text, data?, model, fallback, attempts, cost } | { ok: false, fatal, errors, attempts, cost }
// `fallback` is true when a model after the first one answered.
// A network failure ("fetch failed": no HTTP status, not a timeout) hits every model alike. Two live Quality
// runs lost the connection for minutes and spent each phase's whole chain in seconds, so the next model waits.
// A 429 (rate limit) hits every model of the chain alike too, so it waits the same way.
export const NETWORK_WAIT_MS = 10_000;

// FANE_MAX_COST (USD) stops a run once the calls of one pipeline have cost that much; unset is no limit.
// It is checked before each model call, so the call in flight when it is reached still finishes.
export const maxCostFromEnv = (env = process.env) => costCap(env.FANE_MAX_COST);

// A fatal result carries one of these in `reason` (`status` stays, for callers that read it; the cap has none).
export const STOP_REASONS = Object.freeze(['401', '402', '499', 'cap']);

// What the chain loop does next. Pure: every branch of the loop is decided here, so a table can pin it.
// `stage` is where the loop stands:
//  'before' a model is about to be asked. {free, paidOut, spent, maxCost, offline}
//           -> skipPaid (OpenRouter is out and the model is not free:), stop (cap), waitThenNext {wait}
//              (a network failure is still counted: pause, then ask it) or nextModel (ask it now).
//  'after'  the model answered or failed. {free, freeLater, offline, error?: {status, timeout}, flaw}
//           `flaw` is null for a good answer, else 'length' | 'filter' | 'empty' | 'think' | 'json'.
//           -> answer, stop (401/402/499; a 401/402 with a free: model later in the chain is skipPaid instead),
//              or nextModel. `offline` is the new count of network failures in a row: a 429, or a failure with no
//              status that is no timeout, adds one; any other HTTP error clears it; a bad answer leaves it as it was.
//  'end'    no model is left. {tried, paidOut} -> stop (every model was skipped as paid) or softFail.
export function nextStep(a) {
  if (a.stage === 'before') {
    if (a.paidOut && !a.free) return { kind: 'skipPaid' };
    if (a.spent >= a.maxCost) return { kind: 'stop', reason: 'cap' };
    return a.offline ? { kind: 'waitThenNext', wait: NETWORK_WAIT_MS * a.offline } : { kind: 'nextModel' };
  }
  if (a.stage === 'end') return !a.tried && a.paidOut ? { kind: 'stop', reason: String(a.paidOut.status) } : { kind: 'softFail' };
  if (!a.error) return a.flaw ? { kind: 'nextModel', offline: a.offline } : { kind: 'answer', offline: a.offline };
  const { status, timeout } = a.error;
  const offline = status === 429 || (!status && !timeout) ? a.offline + 1 : 0;
  if (!FATAL_STATUS.has(status)) return { kind: 'nextModel', offline };
  return !isStopped(status) && !a.free && a.freeLater ? { kind: 'skipPaid', offline } : { kind: 'stop', reason: String(status), offline };
}

const FLAW_TEXT = (maxTokens) => ({ length: `cut off at ${maxTokens} tokens`, filter: 'blocked by the provider', empty: 'empty answer', think: 'reasoning in place of an answer', json: 'not JSON' });

export function createRoleCaller({ client, log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)), maxCost = maxCostFromEnv() }) {
  let spent = 0;
  // A bad OpenRouter key or no credits (401/402) when a chain still has free: models (freellmapi): the rest of the run
  // uses only those, instead of stopping. Holds the error that put OpenRouter out.
  let paidOut = null;
  // `json`: whether the role answers JSON; the coding roles (code/models.mjs) say so here, the article roles by name.
  // `code`: the answer is code, which may contain think tags of its own (see stripLeadingThinking).
  // `reasoning`: OpenRouter's reasoning.effort for this call, from the run's profile (core/effort.mjs resolveEffort).
  return async function call(role, { system, user }, { chain, maxTokens, temperature, prices, json = isJsonRole(role), code = false, reasoning = DEFAULT_REASONING }) {
    const attempts = [];
    let cost = 0, offline = 0, at = 0;
    const errorsOf = () => attempts.map(a => `${a.model}: ${a.problem}`);
    while (at < chain.length) {
      const i = at++, model = chain[i], free = isFreeModel(model);
      const before = nextStep({ stage: 'before', free, paidOut, spent, maxCost, offline });
      switch (before.kind) {
        case 'skipPaid': continue;
        case 'stop': return { ok: false, fatal: true, reason: before.reason, errors: [`spend limit of $${maxCost} reached (FANE_MAX_COST)`], attempts, cost };
        case 'waitThenNext': await sleep(before.wait);
      }
      const body = {
        model,
        max_tokens: maxTokens,
        temperature: temperature ?? (json ? 0.2 : 0.7),
        usage: { include: true },
        reasoning: { effort: reasoning },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      };
      let res, failure, flaw = null, text, data;
      try {
        try {
          res = await client.chat(body, json ? 90_000 : 180_000);
        } catch (err) {
          if (!(json && err.status === 400)) throw err;
          delete body.response_format; // the model does not take response_format: ask in the prompt only
          res = await client.chat(body, 90_000);
        }
      } catch (err) {
        failure = { status: err.status, timeout: err.name === 'TimeoutError' || err.name === 'AbortError' };
        const cause = err.cause?.code || err.cause?.message;
        attempts.push({ model, problem: `${String(err.message || err)}${cause ? ` (${cause})` : ''}`.slice(0, 160) });
        log(`${role}: ${model} failed (${attempts.at(-1).problem})`);
      }
      if (!failure) {
        const spend = costOf(res?.usage, prices?.[model]);
        cost += spend;
        spent += spend;
        const choice = res?.choices?.[0];
        const raw = textOf(choice?.message?.content);
        text = code ? stripLeadingThinking(raw) : stripThinking(raw);
        if (choice?.finish_reason === 'length') flaw = 'length';
        else if (choice?.finish_reason === 'content_filter') flaw = 'filter';
        else if (!text) flaw = 'empty';
        else if ((code ? CODE_THINKING_LEAK : THINKING_LEAK).test(text)) flaw = 'think';
        if (!flaw && json) {
          data = extractJson(text);
          if (!data) flaw = 'json';
        }
        attempts.push({ model, problem: flaw ? FLAW_TEXT(maxTokens)[flaw] : null });
        if (flaw) log(`${role}: ${model} gave a bad answer (${attempts.at(-1).problem})`);
      }
      const step = nextStep({ stage: 'after', free, freeLater: chain.slice(i + 1).some(isFreeModel), offline, error: failure, flaw });
      offline = step.offline;
      switch (step.kind) {
        case 'answer': {
          const served = free && res?.routedVia ? `${FREE_PREFIX}${res.routedVia}` : model;
          return { ok: true, text, ...(json ? { data } : {}), model: served, fallback: i > 0, attempts, cost };
        }
        case 'stop': return { ok: false, fatal: true, status: failure.status, reason: step.reason, errors: errorsOf(), attempts, cost };
        case 'skipPaid':
          paidOut = { error: `${model}: ${attempts.at(-1).problem}`, status: failure.status };
          log(`${role}: OpenRouter is out (${failure.status}); the rest of the run uses freellmapi`);
      }
    }
    const end = nextStep({ stage: 'end', tried: attempts.length, paidOut });
    // every model skipped: OpenRouter is out and this chain has no free: model
    if (end.kind === 'stop') return { ok: false, fatal: true, status: paidOut.status, reason: end.reason, errors: [paidOut.error], attempts, cost };
    return { ok: false, fatal: false, errors: errorsOf(), attempts, cost };
  };
}
