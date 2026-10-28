// One role call: try each model of the role's chain until one returns something usable.
// "Usable" is checked here, because reasoner's postmortem (docs/plans/article-flow-truncation-remediation.md)
// found a pipeline cannot see these failures on its own and reports a degraded run as a clean one:
//  - finish_reason "length": the answer was cut at max_tokens
//  - empty content (some models return nothing, then work on a retry elsewhere)
//  - the model's reasoning printed as the answer ("Thinking Process: ...")
//  - JSON roles: no parseable JSON object
// Errors 401/402 (bad key, no credits) hit every model alike and stop the chain.
import { THINKING_LEAK } from './checks.mjs';
import { REASONING, isJsonRole } from './models.mjs';

const FATAL = new Set([401, 402]);

const textOf = (content) => (Array.isArray(content) ? content.map(p => p?.text || '').join('') : String(content ?? '')).trim();
const stripThinking = (s) => s.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();

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

// -> { ok: true, text, data?, model, fallback, attempts, cost } | { ok: false, fatal, errors, attempts, cost }
// `fallback` is true when a model after the first one answered.
// A network failure ("fetch failed": no HTTP status, not a timeout) hits every model alike. Two live Quality
// runs lost the connection for minutes and spent each phase's whole chain in seconds, so the next model waits.
export const NETWORK_WAIT_MS = 10_000;
const isNetworkError = (err) => !err.status && err.name !== 'TimeoutError' && err.name !== 'AbortError';

export function createRoleCaller({ client, log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  // `json`: whether the role answers JSON; the coding roles (code/models.mjs) say so here, the article roles by name.
  return async function call(role, { system, user }, { chain, maxTokens, temperature, prices, json = isJsonRole(role) }) {
    const attempts = [];
    let cost = 0, offline = 0;
    for (const [i, model] of chain.entries()) {
      if (offline) await sleep(NETWORK_WAIT_MS * offline);
      const body = {
        model,
        max_tokens: maxTokens,
        temperature: temperature ?? (json ? 0.2 : 0.7),
        usage: { include: true },
        reasoning: REASONING,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      };
      let res;
      try {
        try {
          res = await client.chat(body, json ? 90_000 : 180_000);
        } catch (err) {
          if (!(json && err.status === 400)) throw err;
          delete body.response_format; // the model does not take response_format: ask in the prompt only
          res = await client.chat(body, 90_000);
        }
      } catch (err) {
        const status = err.status;
        offline = isNetworkError(err) ? offline + 1 : 0;
        const cause = err.cause?.code || err.cause?.message;
        attempts.push({ model, problem: `${String(err.message || err)}${cause ? ` (${cause})` : ''}`.slice(0, 160) });
        log(`${role}: ${model} failed (${attempts.at(-1).problem})`);
        if (FATAL.has(status)) return { ok: false, fatal: true, status, errors: attempts.map(a => `${a.model}: ${a.problem}`), attempts, cost };
        continue;
      }
      cost += costOf(res?.usage, prices?.[model]);
      const choice = res?.choices?.[0];
      const raw = textOf(choice?.message?.content);
      const text = stripThinking(raw);
      let problem = null;
      if (choice?.finish_reason === 'length') problem = `cut off at ${maxTokens} tokens`;
      else if (choice?.finish_reason === 'content_filter') problem = 'blocked by the provider';
      else if (!text) problem = 'empty answer';
      else if (THINKING_LEAK.test(text)) problem = 'reasoning in place of an answer';
      let data;
      if (!problem && json) {
        data = extractJson(text);
        if (!data) problem = 'not JSON';
      }
      if (problem) {
        attempts.push({ model, problem });
        log(`${role}: ${model} gave a bad answer (${problem})`);
        continue;
      }
      attempts.push({ model, problem: null });
      return { ok: true, text, ...(json ? { data } : {}), model, fallback: i > 0, attempts, cost };
    }
    return { ok: false, fatal: false, errors: attempts.map(a => `${a.model}: ${a.problem}`), attempts, cost };
  };
}
