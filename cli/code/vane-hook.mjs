// Code writing inside Vane's web UI. patches/patch-code-chat.js calls handleCodeRequest() from Vane's chat route,
// next to the image and article hooks: a request like "write a Python script that ..." or «γράψε ένα πρόγραμμα
// που ...» is answered with files, a review and tests by the same pipeline as `vane --code`. Documentation and
// vulnerability notes come from Vane's own research (`research`, provided by the patch, as for articles); the
// models run on OpenRouter with the key of Vane's own provider settings, on the chains of the mode's price band
// (selectCodeChains over trial.json). The answer is one block, updated as the work goes. Every answer carries
// CODE_ANSWER_MARKER, so the patched browser code leaves its "[x]" alone.
import { readFile } from 'node:fs/promises';
import { openRouterClientFromVane, openRouterNeeded } from '../image/openrouter.mjs';
import { isImageRequest } from '../image/intent.mjs';
import { escapeHtml, quiet } from '../image/present.mjs';
import { detectLanguage } from '../write/language.mjs';
import { DEFAULT_MODE, MODES } from '../write/models.mjs';
import { retryEmpty } from '../write/research.mjs';
import { buildCodeCatalogue, selectCodeChains } from './catalogue.mjs';
import { isCodeRequest } from './intent.mjs';
import { createCodePipeline } from './pipeline.mjs';
import { codeTagged, renderCodeFailure, renderCodeProgress, renderCodeResult } from './present.mjs';
import { createSyntaxChecker } from './syntax.mjs';

const TRIAL_FILE = new URL('./trial.json', import.meta.url);

// research(query) -> [{ title, url, content }] (Vane's research on this chat's model and mode).
// researchDone() closes Vane's research display. emit(markdown) -> blockId, update(blockId, markdown).
// Returns false when the message is not a coding request (Vane then answers as usual).
// client, trial, pipeline and checkSyntax are injectable for tests.
export async function handleCodeRequest(query, { emit, update, configPath, mode, research, researchDone = () => {}, log = (m) => console.log(`fane: ${m}`), readConfig, client, trial, pipeline, checkSyntax } = {}) {
  if (!isCodeRequest(query) || isImageRequest(query)) return false;
  const lang = detectLanguage(query);
  const state = { lang, phases: [], running: 'spec', files: null };
  const id = emit(codeTagged(renderCodeProgress(state)));
  const say = (markdown) => { try { update(id, codeTagged(markdown)); } catch (err) { log(`could not update the answer: ${err.message}`); } };
  try {
    client ??= await openRouterClientFromVane({ configPath, readConfig, log });
    if (!client) {
      say(quiet([escapeHtml(openRouterNeeded('Code writing'))]));
      return true;
    }
    try { trial ??= JSON.parse(await readFile(TRIAL_FILE, 'utf8')).models || {}; } catch { trial = {}; } // no trial yet: the message below
    const useMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
    const chosen = selectCodeChains(buildCodeCatalogue(await client.models()), trial, { mode: useMode });
    if (!chosen) {
      say(quiet([escapeHtml('No model has passed the coding trial: run node scripts/code-trial.mjs.')]));
      return true;
    }
    const retrieve = retryEmpty(research);
    let queue = Promise.resolve();
    const onProgress = (e) => {
      if (e.status === 'preview') { if (e.files) state.files = e.files; }
      else if (e.status === 'running') state.running = e.phase;
      else {
        state.phases = [...state.phases, { phase: e.phase, status: e.status }];
        if (e.phase === 'docs' || e.phase === 'cve') researchDone();
      }
      if (e.phase !== 'done') queue = queue.then(() => say(renderCodeProgress(state)));
    };
    const write = pipeline || createCodePipeline({ client, retrieve, checkSyntax: checkSyntax || createSyntaxChecker(), log });
    const r = await write({ request: query, mode: useMode, lang, chains: chosen.chains, prices: chosen.prices, onProgress });
    await queue;
    say(r.ok ? renderCodeResult(r) : renderCodeFailure(r, lang));
  } catch (err) {
    log(`code failed: ${err.message}`);
    say(renderCodeFailure({ error: err.message }, lang));
  }
  return true;
}
