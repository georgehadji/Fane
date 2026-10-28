// Brainstorming inside Vane's web UI. patches/patch-brainstorm-chat.js calls handleBrainstormRequest() from Vane's
// chat route, next to the image, article and code hooks: "brainstorm ...", "give me 10 ideas for ..." or «δώσε μου
// ιδέες για ...» is answered by the same pipeline as `vane --brainstorm`. What already exists comes from Vane's own
// research (`research`, provided by the patch, as for articles); the models run on OpenRouter with the key of Vane's
// own provider settings, on the chains of the mode's price band (the article trial's models). The answer is one
// block, updated as the work goes, and ends with ANSWER_MARKER (tagged()) like every Fane answer.
import { readFile } from 'node:fs/promises';
import { createOpenRouterClient, findOpenRouterKey } from '../image/openrouter.mjs';
import { isImageRequest } from '../image/intent.mjs';
import { escapeHtml, quiet, tagged } from '../image/present.mjs';
import { buildTextCatalogue } from '../write/catalogue.mjs';
import { detectLanguage } from '../write/language.mjs';
import { DEFAULT_MODE, MODES } from '../write/models.mjs';
import { isBrainstormRequest } from './intent.mjs';
import { createBrainstormPipeline, selectBrainstormChains } from './pipeline.mjs';
import { renderBrainstormFailure, renderBrainstormProgress, renderBrainstormResult } from './present.mjs';

const TRIAL_FILE = new URL('../write/trial.json', import.meta.url);

// research(query) -> [{ title, url, content }] (Vane's research on this chat's model and mode).
// researchDone() closes Vane's research display. emit(markdown) -> blockId, update(blockId, markdown).
// Returns false when the message is not a brainstorm request (Vane then answers as usual).
// client, trial and pipeline are injectable for tests.
export async function handleBrainstormRequest(query, { emit, update, configPath, mode, research, researchDone = () => {}, log = (m) => console.log(`fane: ${m}`), readConfig, client, trial, pipeline } = {}) {
  if (!isBrainstormRequest(query) || isImageRequest(query)) return false;
  const lang = detectLanguage(query);
  const state = { lang, running: mode === 'speed' ? 'generate' : 'prior', done: [], ideas: [] };
  const id = emit(tagged(renderBrainstormProgress(state)));
  const say = (markdown) => { try { update(id, tagged(markdown)); } catch (err) { log(`could not update the answer: ${err.message}`); } };
  try {
    if (!client) {
      let apiKey = null;
      try { apiKey = findOpenRouterKey(JSON.parse(readConfig ? await readConfig() : await readFile(configPath, 'utf8')).modelProviders); } catch (err) { log(`could not read Vane config: ${err.message}`); }
      if (!apiKey) {
        say(quiet([escapeHtml('Brainstorming needs an OpenRouter provider: in Settings → Models, add an OpenAI-compatible provider with Base URL https://openrouter.ai/api/v1 and your OpenRouter API key.')]));
        return true;
      }
      client = createOpenRouterClient({ apiKey });
    }
    try { trial ??= JSON.parse(await readFile(TRIAL_FILE, 'utf8')).models || {}; } catch { trial = {}; } // no trial yet: the message below
    const useMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
    const chosen = selectBrainstormChains(buildTextCatalogue(await client.models()), trial, { mode: useMode, lang });
    if (!chosen) {
      say(quiet([escapeHtml('No text model has passed the article trial: run node scripts/article-trial.mjs.')]));
      return true;
    }
    // Vane sometimes finds no sources for a query that worked a minute ago: one retry.
    const retrieve = research ? async (q) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const found = await research(q);
        if (found.length) return found;
      }
      return [];
    } : undefined;
    let queue = Promise.resolve();
    const onProgress = (e) => {
      if (e.status === 'preview') { if (e.ideas) state.ideas = e.ideas; }
      else if (e.status === 'running') state.running = e.phase;
      else {
        state.done = [...state.done, e.phase];
        if (e.phase === 'prior') researchDone();
      }
      if (e.phase !== 'done') queue = queue.then(() => say(renderBrainstormProgress(state)));
    };
    const run = pipeline || createBrainstormPipeline({ client, retrieve, log });
    const r = await run({ request: query, mode: useMode, lang, chains: chosen.chains, prices: chosen.prices, onProgress });
    await queue;
    say(r.ok ? renderBrainstormResult(r) : renderBrainstormFailure(r, lang));
  } catch (err) {
    log(`brainstorm failed: ${err.message}`);
    say(renderBrainstormFailure({ error: err.message }, lang));
  }
  return true;
}
