// Brainstorming inside Vane's web UI. patches/patch-brainstorm-chat.js calls handleBrainstormRequest() from Vane's
// chat route, next to the image, article and code hooks: "brainstorm ...", "give me 10 ideas for ..." or «δώσε μου
// ιδέες για ...» is answered by the same pipeline as `vane --brainstorm`. What already exists comes from Vane's own
// research (`research`, provided by the patch, as for articles); the models run on OpenRouter with the key of Vane's
// own provider settings, on the chains of the mode's price band (the article trial's models). The answer is one
// block, updated as the work goes, and ends with ANSWER_MARKER (tagged()) like every Fane answer.
import { readFile } from 'node:fs/promises';
import { openRouterClientFromVane, openRouterNeeded } from '../image/openrouter.mjs';
import { isImageRequest } from '../image/intent.mjs';
import { escapeHtml, quiet, tagged } from '../image/present.mjs';
import { buildTextCatalogue } from '../write/catalogue.mjs';
import { detectLanguage } from '../core/language.mjs';
import { DEFAULT_MODE, MODES } from '../write/models.mjs';
import { retryEmpty } from '../write/research.mjs';
import { isBrainstormRequest } from '../core/intent-brainstorm.mjs';
import { beginRun } from '../core/runlog.mjs';
import { createBrainstormPipeline, selectBrainstormChains } from './pipeline.mjs';
import { brainstormPrompts } from './prompts.mjs';
import { renderBrainstormFailure, renderBrainstormProgress, renderBrainstormResult } from './present.mjs';

const TRIAL_FILE = new URL('../write/trial.json', import.meta.url);

// research(query) -> [{ title, url, content }] (Vane's research on this chat's model and mode).
// researchDone() closes Vane's research display. emit(markdown) -> blockId, update(blockId, markdown).
// Returns false when the message is not a brainstorm request (Vane then answers as usual).
// client, trial and pipeline are injectable for tests.
export async function handleBrainstormRequest(query, { emit, update, configPath, mode, research, researchDone = () => {}, log = (m) => console.log(`fane: ${m}`), readConfig, signal, client, trial, pipeline } = {}) {
  if (!isBrainstormRequest(query) || isImageRequest(query)) return false;
  const lang = detectLanguage(query);
  const track = beginRun('brainstorm', log, brainstormPrompts);
  log = track.log;
  const state = { lang, running: mode === 'speed' ? 'generate' : 'prior', done: [], ideas: [] };
  const id = emit(tagged(renderBrainstormProgress(state)));
  const say = (markdown) => { try { update(id, tagged(markdown)); } catch (err) { log(`could not update the answer: ${err.message}`); } };
  try {
    client ??= await openRouterClientFromVane({ configPath, readConfig, log, signal });
    if (!client) {
      say(quiet([escapeHtml(openRouterNeeded('Brainstorming'))]));
      return true;
    }
    try { trial ??= JSON.parse(await readFile(TRIAL_FILE, 'utf8')).models || {}; } catch { trial = {}; } // no trial yet: the message below
    const useMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
    const chosen = selectBrainstormChains(buildTextCatalogue(await client.models()), trial, { mode: useMode, lang });
    if (!chosen) {
      say(quiet([escapeHtml('No text model has passed the article trial: run node scripts/article-trial.mjs.')]));
      return true;
    }
    const retrieve = retryEmpty(research);
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
    track.finish(r);
  } catch (err) {
    log(`brainstorm failed: ${err.message}`);
    say(renderBrainstormFailure({ error: err.message }, lang));
    track.finish({ ok: false });
  }
  return true;
}
