// Discover summaries in Greek. Vane's Discover route returns English stories next to the Greek ones
// (patch-discover-greek); this translates the English summaries (`content`, not the titles) through the chat model of
// Vane's own providers, so the whole page reads in Greek. It runs inside Vane's route (patch-discover-translate imports
// it from FANE_IMAGE_DIR) and fails open: no provider, a late or malformed answer, and the story keeps its English text.
// A translation is kept per story in memory, so only the first load of a page waits for the model, and one that
// finishes after the deadline is there for the next load.
import { greekShare, repairFinalNu, repairHomoglyphs } from '../core/language.mjs';
import { DEFAULT_TEXT_MODEL, FREE_MODEL, openRouterClientFromVane } from './openrouter.mjs';

const BATCH = 12;
const MAX_CACHED = 2000;
const SYSTEM = 'You translate news summaries into Greek. Reply with a JSON array of strings only: one translation per input, same order, same length. Natural journalistic Greek; keep names, brands, numbers and units; keep a trailing "..." as it is.';

const CACHE = new Map(); // english summary -> Greek
const INFLIGHT = new Map(); // english summary -> promise of its Greek text (or null)

const needsGreek = (b) => b && typeof b.content === 'string' && b.content.trim() && greekShare(b.content) < 0.33;

function remember(english, greek) {
  CACHE.set(english, greek);
  for (const key of CACHE.keys()) { if (CACHE.size <= MAX_CACHED) break; CACHE.delete(key); }
}

// -> the translations of `texts` in order, or null for a batch the model did not answer as asked
async function translateBatch(client, model, texts) {
  const raw = await client.complete(model, SYSTEM, JSON.stringify(texts), { maxTokens: 4000, temperature: 0.2 });
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  let out;
  try { out = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(out) || out.length !== texts.length || out.some(s => typeof s !== 'string' || !s.trim())) return null;
  return out.map(s => repairFinalNu(repairHomoglyphs(s.trim()).text).text);
}

// `items` are Discover stories ({ title, url, content, ... }); -> the same list with Greek `content` where it was ready
// within `deadlineMs`. `client` and `model` are for tests.
export async function greekSummaries(items, { configPath, readConfig, client, model, deadlineMs = 25_000, log = console.log } = {}) {
  if (!Array.isArray(items)) return items;
  const todo = [...new Set(items.filter(needsGreek).map(b => b.content).filter(t => !CACHE.has(t) && !INFLIGHT.has(t)))];
  if (todo.length) {
    client ??= await openRouterClientFromVane({ configPath, readConfig, log });
    if (!client) log('fane: Discover summaries stay English: Vane has no OpenRouter or freellmapi provider');
    else {
      const chosen = model || (client.freeLlm === 'only' ? FREE_MODEL.speed : DEFAULT_TEXT_MODEL);
      for (let i = 0; i < todo.length; i += BATCH) {
        const texts = todo.slice(i, i + BATCH);
        const batch = translateBatch(client, chosen, texts).catch((err) => { log(`fane: Discover translation failed: ${err.message}`); return null; });
        texts.forEach((t, j) => {
          const p = batch.then((out) => { if (out) remember(t, out[j]); INFLIGHT.delete(t); return out?.[j] ?? null; });
          INFLIGHT.set(t, p);
        });
      }
    }
  }
  const waiting = items.filter(b => needsGreek(b) && INFLIGHT.has(b.content)).map(b => INFLIGHT.get(b.content));
  if (waiting.length) {
    let timer;
    await Promise.race([Promise.all(waiting), new Promise((resolve) => { timer = setTimeout(resolve, deadlineMs); })]);
    clearTimeout(timer);
  }
  return items.map(b => (needsGreek(b) && CACHE.has(b.content) ? { ...b, content: CACHE.get(b.content) } : b));
}

export const _cache = CACHE; // for tests
