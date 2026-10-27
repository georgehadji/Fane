// OpenRouter adapter: the only module that talks HTTP to openrouter.ai. `fetchImpl` is
// injected so tests run without a network. Errors carry the HTTP/provider status so the
// caller can stop early on 401/402 (they affect every model alike). The key is only ever
// sent in the Authorization header, never logged or put in an error message.

export class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const OPENROUTER_HOST = 'openrouter.ai';
export const OPENROUTER_BASE_URL = `https://${OPENROUTER_HOST}/api/v1`;

export function createOpenRouterClient({ apiKey, baseUrl = OPENROUTER_BASE_URL, fetchImpl = fetch } = {}) {
  async function call(path, { method = 'GET', body, timeoutMs = 90_000 } = {}) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/georgehadji/Fane',
        'X-Title': 'Fane',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
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
