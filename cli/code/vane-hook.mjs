// Code writing inside Vane's web UI. patches/patch-code-chat.js calls handleCodeRequest() from Vane's chat route,
// next to the image and article hooks: a request like "write a Python script that ..." or «γράψε ένα πρόγραμμα
// που ...» is answered with files, a review and tests by the same pipeline as `vane --code`. Documentation and
// vulnerability notes come from Vane's own research (`research`, provided by the patch, as for articles); the
// models run on OpenRouter with the key of Vane's own provider settings, on the chains of the mode's price band
// (selectCodeChains over trial.json), or on freellmapi (withFreeLlm). The answer is one block, updated as the work goes. Every answer carries
// CODE_ANSWER_MARKER, so the patched browser code leaves its "[x]" alone.
import { openRouterClientFromVane, withFreeLlm } from '../image/openrouter.mjs';
import { isImageRequest } from '../image/intent.mjs';
import { escapeHtml, previousAnswer, providerMissing, quiet } from '../image/present.mjs';
import { detectLanguage } from '../core/language.mjs';
import { DEFAULT_MODE, MODES } from '../write/models.mjs';
import { retryEmpty } from '../write/research.mjs';
import { buildCodeCatalogue, selectCodeChains, selectFreeCodeChains } from './catalogue.mjs';
import { isCodeEdit, isCodeRequest } from '../core/intent-code.mjs';
import { createTurn } from '../core/turn.mjs';
import { parseCodeAnswer } from './edit.mjs';
import { codeChainsFor } from './models.mjs';
import { createCodeEditor, createCodePipeline } from './pipeline.mjs';
import { readTrial } from '../write/trial.mjs';
import { codePrompts } from './prompts.mjs';
import { codeTagged, renderCodeFailure, renderCodeProgress, renderCodeResult } from './present.mjs';
import { createSyntaxChecker } from './syntax.mjs';

const TRIAL_FILE = new URL('./trial.json', import.meta.url);

// research(query) -> [{ title, url, content }] (Vane's research on this chat's model and mode).
// researchDone() closes Vane's research display. emit(markdown) -> blockId, update(blockId, markdown).
// lastAnswer() -> text of the previous answer, history -> the browser's chat history (see previousAnswer).
// Returns false when the message is neither a coding request nor an edit of the code the previous answer was
// (Vane then answers as usual). client, trial, pipeline, editor and checkSyntax are injectable for tests.
export async function handleCodeRequest(query, { emit, update, configPath, mode, history, lastAnswer, research, researchDone = () => {}, log = (m) => console.log(`fane: ${m}`), readConfig, signal, client, trial, pipeline, editor, checkSyntax } = {}) {
  if (isImageRequest(query)) return false;
  // A request for new code first ("write a function that ..."); else a change to the code of the answer before
  // ("add input validation"), which needs that answer to be a code answer of ours (it carries CODE_ANSWER_MARKER).
  let earlier = null;
  if (!isCodeRequest(query)) {
    if (!isCodeEdit(query)) return false;
    earlier = parseCodeAnswer(await previousAnswer(history, lastAnswer));
    if (!earlier) return false;
  }
  const lang = detectLanguage(query);
  const state = { lang, phases: [], running: earlier ? 'edit' : 'spec', files: null };
  const turn = createTurn({ feature: earlier ? 'code-edit' : 'code', prompts: codePrompts, emit, update, log, tag: codeTagged });
  const { say } = turn;
  log = turn.log;
  await turn.run(renderCodeProgress(state), async () => {
    client ??= await openRouterClientFromVane({ configPath, readConfig, log, signal });
    if (!client) return say(providerMissing('Code writing', { free: true }));
    trial ??= await readTrial(TRIAL_FILE); // no trial yet is {}, and the message below
    const useMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
    const chosen = await withFreeLlm(client, useMode, {
      select: async () => selectCodeChains(buildCodeCatalogue(await client.models()), trial, { mode: useMode }),
      free: (ready, last) => selectFreeCodeChains(trial, ready, last),
      only: codeChainsFor,
    });
    if (!chosen) return say(quiet([escapeHtml('No model has passed the coding trial: run node scripts/code-trial.mjs.')]));
    const onProgress = turn.progress((e) => {
      if (e.status === 'preview') { if (e.files) state.files = e.files; }
      else if (e.status === 'running') state.running = e.phase;
      else {
        state.phases = [...state.phases, { phase: e.phase, status: e.status }];
        if ((e.phase === 'docs' || e.phase === 'cve') && e.status === 'done') researchDone();
      }
      if (e.phase !== 'done') return () => renderCodeProgress(state);
    });
    let r;
    if (earlier) {
      // no research: a change works with the code the answer before already holds
      const edit = editor || createCodeEditor({ client, checkSyntax: checkSyntax || createSyntaxChecker(), log });
      r = await edit({ files: earlier.files, tests: earlier.tests, summary: earlier.summary, language: earlier.language, change: query, mode: useMode, lang, chains: chosen.chains, prices: chosen.prices, onProgress });
    } else {
      const write = pipeline || createCodePipeline({ client, retrieve: retryEmpty(research), checkSyntax: checkSyntax || createSyntaxChecker(), log });
      r = await write({ request: query, mode: useMode, lang, chains: chosen.chains, prices: chosen.prices, onProgress });
    }
    await turn.settle();
    say(r.ok ? renderCodeResult(r) : renderCodeFailure({ ...r, edit: !!earlier }, lang));
    return r;
  }, { failed: (err) => {
    log(`code ${earlier ? 'edit ' : ''}failed: ${err.message}`);
    say(renderCodeFailure({ error: err.message, edit: !!earlier }, lang));
  } });
  return true;
}
