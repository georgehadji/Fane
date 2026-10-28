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

// freellmapi (github.com/tashfeenahmed/freellmapi) is a local OpenAI-compatible gateway over the free tiers of many
// providers, with its own failover between them. Vane knows it as a provider whose key starts with `freellmapi-`.
// A chain entry `free:<model>` (`free:auto`, `free:auto:smart`, or one of its model ids) goes there, the rest to OpenRouter.
export const FREE_PREFIX = 'free:';
export const FREE_KEY_PREFIX = 'freellmapi-';
export const isFreeModel = (id) => String(id ?? '').startsWith(FREE_PREFIX);
// Vane's mode picks freellmapi's routing: its fastest models, its active chain, its most capable models.
export const FREE_MODEL = { speed: 'free:auto:fast', balanced: 'free:auto', quality: 'free:auto:smart' };

export function findFreeLlm(modelProviders) {
  const p = (modelProviders || []).find(p => String(p.config?.apiKey || '').startsWith(FREE_KEY_PREFIX) && p.config?.baseURL);
  return p ? { apiKey: p.config.apiKey, baseUrl: String(p.config.baseURL).replace(/\/+$/, '') } : null;
}

// What the web UI says when Vane has no provider for a feature; `what` is the feature ("Code writing"), `free`: whether
// freellmapi would do (the text features; images need OpenRouter).
export const openRouterNeeded = (what, { free = false } = {}) => `${what} needs an OpenRouter provider: in Settings → Models, add an OpenAI-compatible provider with Base URL ${OPENROUTER_BASE_URL} and your OpenRouter API key.${free ? ` For free models, a freellmapi provider works too (its Base URL, such as http://host.docker.internal:3001/v1, and its ${FREE_KEY_PREFIX}… key).` : ''}`;

// The client for the providers in Vane's list (`apiKey`, when given, is the OpenRouter key to use instead of Vane's).
// null without either provider, the plain OpenRouter client without freellmapi. With freellmapi, `freeLlm` says whether
// it is the only provider ('only') or the fallback behind OpenRouter ('fallback'); `free:` models go to it.
export function modelClientFor(modelProviders, { apiKey = findOpenRouterKey(modelProviders), signal, fetchImpl, freeBaseUrl = (u) => u } = {}) {
  const openRouter = apiKey ? createOpenRouterClient({ apiKey, signal, fetchImpl }) : null;
  const found = findFreeLlm(modelProviders);
  if (!found) return openRouter;
  const free = createOpenRouterClient({ apiKey: found.apiKey, baseUrl: freeBaseUrl(found.baseUrl), signal, fetchImpl });
  const none = (model) => { throw new OpenRouterError(`404 ${model}: Vane has no OpenRouter provider`, 404); };
  const pick = (model) => (isFreeModel(model) ? [free, model.slice(FREE_PREFIX.length)] : openRouter ? [openRouter, model] : none(model));
  return {
    freeLlm: openRouter ? 'fallback' : 'only',
    // the models freellmapi can serve right now (a key, inside its limits), as free: ids
    freeReady: async () => (await free.models('?execution_status=ready')).map(m => `${FREE_PREFIX}${m.id}`),
    models: async () => (openRouter ? openRouter.models() : []),
    imageModels: async () => (openRouter ? openRouter.imageModels() : []),
    images: async (body, timeoutMs) => (openRouter ? openRouter.images(body, timeoutMs) : none(body.model)),
    async chat(body, timeoutMs) {
      const [client, model] = pick(body.model);
      if (client === openRouter) return client.chat(body, timeoutMs);
      const { usage, ...rest } = body; // OpenRouter's own field: strict providers behind freellmapi refuse unknown keys
      return client.chat({ ...rest, model }, timeoutMs);
    },
    async complete(model, ...rest) {
      const [client, id] = pick(model);
      return client.complete(id, ...rest);
    },
  };
}

// The chains a text feature runs on, from three choices of the feature's own:
//   select()          its OpenRouter models (null when none passed its trial)
//   free(ready, last) the free models that passed its trial (selectFreeChains), each chain ending in `last`, the mode's
//                     router entry; `ready` is what freellmapi can serve now (null when it would not say); null when none passed
//   only(models)      its chains of just these models
// freellmapi alone serves every role on its ranked free models (else on `last`); next to OpenRouter its chains follow
// every OpenRouter chain, and serve alone when no OpenRouter model passed the trial.
export async function withFreeLlm(client, mode, { select, free, only }) {
  if (!client.freeLlm) return select();
  const last = FREE_MODEL[mode] || FREE_MODEL.balanced;
  const ready = await client.freeReady().catch(() => null);
  const freeChosen = free(ready, last) || { chains: only([last]), prices: {} };
  // OpenRouter's catalogue unreachable: freellmapi serves the run alone rather than none at all
  const chosen = client.freeLlm === 'only' ? null : await select().catch(() => null);
  if (!chosen) return freeChosen;
  return { ...chosen, chains: Object.fromEntries(Object.entries(chosen.chains).map(([role, chain]) => [role, [...chain, ...(freeChosen.chains[role] || [last])]])) };
}

// freellmapi as Vane's container knows it (host.docker.internal), reached from the host, where it listens on 127.0.0.1.
export const fromHost = (url) => url.replace('//host.docker.internal', '//127.0.0.1');

// The client for the providers in Vane's own settings, for the hooks that run inside Vane: config.json is read from
// `configPath` (or `readConfig()`, injected for tests). null when the file cannot be read or has neither provider.
export async function openRouterClientFromVane({ configPath, readConfig, log = () => {}, signal }) {
  let providers = [];
  try { providers = JSON.parse(readConfig ? await readConfig() : await readFile(configPath, 'utf8')).modelProviders; } catch (err) { log(`could not read Vane config: ${err.message}`); }
  return modelClientFor(providers, { signal: runSignal(signal) });
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
    // freellmapi names the model it routed an `auto` call to (platform/model)
    const via = res.headers?.get?.('x-routed-via');
    if (via && json && typeof json === 'object') json.routedVia = via;
    return json;
  }

  return {
    // Public catalogue (no key needed). The plain list omits pure image generators.
    models: async (query = '') => (await call(`/models${query}`, { timeoutMs: 15_000 })).data || [],
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
