// OpenRouter adapter: the only module that talks HTTP to openrouter.ai. `fetchImpl` is
// injected so tests run without a network. Errors carry the HTTP/provider status so the
// caller can stop early on 401/402 (they affect every model alike). The key is only ever
// sent in the Authorization header, never logged or put in an error message.

import { readFile } from 'node:fs/promises';
import { STOPPED_STATUS } from '../core/runlog.mjs';

export class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const OPENROUTER_HOST = 'openrouter.ai';
export const OPENROUTER_BASE_URL = `https://${OPENROUTER_HOST}/api/v1`;

// 499 (STOPPED_STATUS, core/runlog.mjs): the run was stopped (the browser closed, or the deadline passed), so nothing more is spent.
export { STOPPED_STATUS };

// Bad key or no credits: every model fails the same way, so a chain stops at the first. A stopped run does too.
export const FATAL_STATUS = new Set([401, 402, STOPPED_STATUS]);

// How long one web request may run in total, in minutes (FANE_DEADLINE_MIN; 0 turns the deadline off).
export const deadlineFromEnv = (env = process.env) => {
  const n = env.FANE_DEADLINE_MIN === undefined || env.FANE_DEADLINE_MIN === '' ? 30 : Number(env.FANE_DEADLINE_MIN);
  return n >= 0 ? n * 60_000 : 30 * 60_000;
};

// The signal a hook's calls obey: the request's own (aborted when the browser disconnects) and the deadline.
export function runSignal(signal, deadlineMs = deadlineFromEnv()) {
  const parts = [signal, deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : null].filter(Boolean);
  return parts.length ? AbortSignal.any(parts) : undefined;
}

// The text model used when no chain says otherwise (prompt enhancing, and the chain of a role with no models).
export const DEFAULT_TEXT_MODEL = 'google/gemini-3.5-flash-lite';

// The API key of the Vane provider that points at OpenRouter. `modelProviders` is Vane's
// config list ({ name, type, config: { baseURL, apiKey } }) from /api/config or config.json.
export const findOpenRouterKey = (modelProviders) =>
  (modelProviders || []).find(p => String(p.config?.baseURL || '').includes(OPENROUTER_HOST) && p.config?.apiKey)?.config.apiKey || null;

// What the web UI says when Vane has no OpenRouter provider; `what` is the feature ("Code writing").
export const openRouterNeeded = (what) => `${what} needs an OpenRouter provider: in Settings → Models, add an OpenAI-compatible provider with Base URL ${OPENROUTER_BASE_URL} and your OpenRouter API key.`;

// The client for the key in Vane's own settings, for the hooks that run inside Vane: config.json is read from
// `configPath` (or `readConfig()`, injected for tests). null when the file cannot be read or has no OpenRouter provider.
export async function openRouterClientFromVane({ configPath, readConfig, log = () => {}, signal }) {
  let apiKey = null;
  try { apiKey = findOpenRouterKey(JSON.parse(readConfig ? await readConfig() : await readFile(configPath, 'utf8')).modelProviders); } catch (err) { log(`could not read Vane config: ${err.message}`); }
  return apiKey ? createOpenRouterClient({ apiKey, signal: runSignal(signal) }) : null;
}

// `signal` stops every call of this client, in flight or not yet made (a pipeline then ends on the 499).
export function createOpenRouterClient({ apiKey, baseUrl = OPENROUTER_BASE_URL, fetchImpl = fetch, signal } = {}) {
  const stopped = () => new OpenRouterError(signal.reason?.name === 'TimeoutError' ? 'stopped: the run reached its time limit' : 'stopped: the request was closed', STOPPED_STATUS);

  async function call(path, { method = 'GET', body, timeoutMs = 90_000 } = {}) {
    if (signal?.aborted) throw stopped();
    let res, text;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/georgehadji/Fane',
          'X-Title': 'Fane',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw signal?.aborted ? stopped() : err;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok || json?.error) {
      const status = Number(json?.error?.code) || res.status;
      throw new OpenRouterError(`${status} ${json?.error?.message || text.slice(0, 200) || res.statusText}`, status);
    }
    return json;
  }

  return {
    // Public catalogue (no key needed). The plain list omits pure image generators.
    models: async () => (await call('/models', { timeoutMs: 15_000 })).data || [],
    // Image-output models, including Flux, Recraft, Seedream and the chat models that draw.
    imageModels: async () => (await call('/models?output_modalities=image', { timeoutMs: 15_000 })).data || [],
    chat: (body, timeoutMs = 120_000) => call('/chat/completions', { method: 'POST', body, timeoutMs }),
    // Image API for pure generators: { model, prompt, n, aspect_ratio, resolution, input_references }
    // -> { data: [{ b64_json, media_type }] }.
    images: (body, timeoutMs = 120_000) => call('/images', { method: 'POST', body, timeoutMs }),
    async complete(model, system, user, { maxTokens = 512, temperature = 0.7 } = {}) {
      const j = await call('/chat/completions', {
        method: 'POST',
        timeoutMs: 30_000,
        body: { model, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
      });
      const c = j?.choices?.[0]?.message?.content;
      return (Array.isArray(c) ? c.map(p => p?.text || '').join('') : String(c || '')).trim();
    },
  };
}
