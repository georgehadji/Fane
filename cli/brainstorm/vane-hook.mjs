// Brainstorming inside Vane's web UI. patches/patch-brainstorm-chat.js calls handleBrainstormRequest() from Vane's
// chat route, next to the image, article and code hooks: "brainstorm ...", "give me 10 ideas for ..." or «δώσε μου
// ιδέες για ...» is answered by the same pipeline as `vane --brainstorm`. What already exists comes from Vane's own
// research (`research`, provided by the patch, as for articles); the models run on OpenRouter with the key of Vane's
// own provider settings, on the chains of the mode's price band (the article trial's models), or on freellmapi
// (withFreeLlm). The answer is one
// block, updated as the work goes, and ends with ANSWER_MARKER (tagged()) like every Fane answer.
import { openRouterClientFromVane, withFreeLlm } from '../image/openrouter.mjs';
import { isImageRequest } from '../image/intent.mjs';
import { escapeHtml, providerMissing, quiet, tagged } from '../image/present.mjs';
import { buildTextCatalogue } from '../write/catalogue.mjs';
import { detectLanguage } from '../core/language.mjs';
import { DEFAULT_MODE, MODES } from '../write/models.mjs';
import { retryEmpty } from '../write/research.mjs';
import { readTrial } from '../write/trial.mjs';
import { isBrainstormRequest } from '../core/intent-brainstorm.mjs';
import { createTurn } from '../core/turn.mjs';
import { chainsFor, createBrainstormPipeline, selectBrainstormChains, selectFreeBrainstormChains } from './pipeline.mjs';
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
  const useMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
  const state = { lang, running: useMode === 'speed' ? 'generate' : 'prior', done: [], ideas: [] };
  const turn = createTurn({ feature: 'brainstorm', prompts: brainstormPrompts, emit, update, log, tag: tagged });
  const { say } = turn;
  log = turn.log;
  await turn.run(renderBrainstormProgress(state), async () => {
    client ??= await openRouterClientFromVane({ configPath, readConfig, log, signal });
    if (!client) return say(providerMissing('Brainstorming', { free: true }));
    trial ??= await readTrial(TRIAL_FILE); // no trial yet is {}, and the message below
    const chosen = await withFreeLlm(client, useMode, {
      select: async () => selectBrainstormChains(buildTextCatalogue(await client.models()), trial, { mode: useMode, lang }),
      free: (ready, last) => selectFreeBrainstormChains(trial, ready, { lang, last }),
      only: chainsFor,
    });
    if (!chosen) return say(quiet([escapeHtml('No text model has passed the article trial: run node scripts/article-trial.mjs.')]));
    const retrieve = retryEmpty(research);
    const onProgress = turn.progress((e) => {
      if (e.status === 'preview') { if (e.ideas) state.ideas = e.ideas; }
      else if (e.status === 'running') state.running = e.phase;
      else {
        state.done = [...state.done, e.phase];
        if (e.phase === 'prior' && e.status === 'done') researchDone();
      }
      if (e.phase !== 'done') return () => renderBrainstormProgress(state);
    });
    const brainstorm = pipeline || createBrainstormPipeline({ client, retrieve, log });
    const r = await brainstorm({ request: query, mode: useMode, lang, chains: chosen.chains, prices: chosen.prices, onProgress });
    await turn.settle();
    say(r.ok ? renderBrainstormResult(r) : renderBrainstormFailure(r, lang));
    return r;
  }, { failed: (err) => {
    log(`brainstorm failed: ${err.message}`);
    say(renderBrainstormFailure({ error: err.message }, lang));
  } });
  return true;
}
