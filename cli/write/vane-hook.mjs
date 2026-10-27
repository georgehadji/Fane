// Article writing inside Vane's web UI. patches/patch-article-chat.js calls handleArticleRequest()
// from Vane's chat route, next to the image hook: a request like "write an article about ..." or
// "γράψε ένα άρθρο για ..." is answered with a cited article instead of a short text answer, by the
// same pipeline as `vane --article`. Sources come from Vane's own research (`research`, provided by
// the patch: Vane's research class run on the user's chosen model and mode, so its progress shows in
// the answer as usual); the writing runs on OpenRouter with the key of Vane's own provider settings,
// on the models of the mode's price band (selectChains over trial.json).
// Vane's mode picks the phases: Speed = outline and draft, Balanced adds checks and edits, Quality
// adds the audit. The answer is one block, updated as the work goes: status lines, then the draft
// as soon as it exists, then the finished article.
import { readFile } from 'node:fs/promises';
import { createOpenRouterClient, findOpenRouterKey } from '../image/openrouter.mjs';
import { previousAnswer } from '../image/vane-hook.mjs';
import { isImageRequest } from '../image/intent.mjs';
import { escapeHtml, quiet, tagged } from '../image/present.mjs';
import { buildTextCatalogue, selectChains } from './catalogue.mjs';
import { createArticleEditor, isArticleEdit, parseArticleAnswer, targetLanguage } from './edit.mjs';
import { articleTopic, isArticleRequest, parseArticleOptions } from './intent.mjs';
import { LANGUAGE_NAMES, detectLanguage } from './language.mjs';
import { DEFAULT_MODE, MODES } from './models.mjs';
import { createArticlePipeline } from './pipeline.mjs';
import { renderArticleFailure, renderArticleProgress, renderArticleResult } from './present.mjs';

const TRIAL_FILE = new URL('./trial.json', import.meta.url);

// research(query) -> [{ title, url, content }] (Vane's research on this chat's model and mode).
// researchDone() closes Vane's research display. emit(markdown) -> blockId, update(blockId, markdown).
// lastAnswer() -> text of the previous answer, history -> the browser's chat history (see previousAnswer).
// Returns false when the message is neither an article request nor an edit of the article the previous
// answer was (Vane then answers as usual). client, trial, pipeline and editor are injectable for tests.
export async function handleArticleRequest(query, { emit, update, configPath, mode, history, lastAnswer, research, researchDone = () => {}, log = (m) => console.log(`fane: ${m}`), readConfig, client, trial, pipeline, editor } = {}) {
  // A follow-up edit: the message reads like one ("shorter", "rewrite the intro") and the answer before it is an article of ours.
  let earlier = null;
  if (!isArticleRequest(query)) {
    if (isImageRequest(query) || !isArticleEdit(query)) return false;
    earlier = parseArticleAnswer(await previousAnswer(history, lastAnswer));
    if (!earlier) return false;
  }
  const topic = earlier ? query : articleTopic(query);
  const lang = earlier ? targetLanguage(query, earlier.lang) : detectLanguage(topic);
  const state = { lang, phases: [], running: earlier ? 'edit' : 'sources', draft: null };
  const id = emit(tagged(renderArticleProgress(state)));
  const say = (markdown) => { try { update(id, tagged(markdown)); } catch (err) { log(`could not update the answer: ${err.message}`); } };
  try {
    if (!client) {
      let apiKey = null;
      try { apiKey = findOpenRouterKey(JSON.parse(readConfig ? await readConfig() : await readFile(configPath, 'utf8')).modelProviders); } catch (err) { log(`could not read Vane config: ${err.message}`); }
      if (!apiKey) {
        say(quiet([escapeHtml('Article writing needs an OpenRouter provider: in Settings → Models, add an OpenAI-compatible provider with Base URL https://openrouter.ai/api/v1 and your OpenRouter API key.')]));
        return true;
      }
      client = createOpenRouterClient({ apiKey });
    }
    trial ??= JSON.parse(await readFile(TRIAL_FILE, 'utf8')).models || {};
    const useMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
    const chosen = selectChains(buildTextCatalogue(await client.models()), trial, { mode: useMode, lang });
    if (!chosen) {
      say(quiet([escapeHtml(`No text model has passed the trial for ${LANGUAGE_NAMES[lang]}: run node scripts/article-trial.mjs, or ask in English.`)]));
      return true;
    }
    // Vane sometimes finds no sources for a query that worked a minute ago: one retry.
    const retrieve = async (q) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const found = await research(q);
        if (found.length) return found;
      }
      return [];
    };
    if (earlier) {
      const edit = editor || createArticleEditor({ client, log });
      const onEdit = (e) => {
        if (e.phase === 'sources' && e.status === 'done') researchDone();
        if (e.status === 'running') { state.running = e.phase; say(renderArticleProgress(state)); }
      };
      const r = await edit({ body: earlier.body, sources: earlier.sources, instruction: query, lang, mode: useMode, chains: chosen.chains, prices: chosen.prices, retrieve: research ? retrieve : undefined, onProgress: onEdit });
      say(r.ok ? renderArticleResult(r) : renderArticleFailure({ ...r, edit: true }, lang));
      return true;
    }
    // Updates are applied in order, one at a time.
    let queue = Promise.resolve();
    const onProgress = (e) => {
      if (e.status === 'preview') state.draft = { text: e.text, sources: e.sources };
      else if (e.status === 'running') state.running = e.phase;
      else {
        state.phases = [...state.phases.filter(p => p.phase !== e.phase), { phase: e.phase, status: e.status }];
        if (e.phase === 'sources') researchDone();
      }
      if (e.phase !== 'done') queue = queue.then(() => say(renderArticleProgress(state)));
    };
    const write = pipeline || createArticlePipeline({ client, retrieve, log });
    const r = await write({ topic, mode: useMode, lang, words: parseArticleOptions(query).words, chains: chosen.chains, prices: chosen.prices, onProgress });
    await queue;
    say(r.ok ? renderArticleResult(r) : renderArticleFailure(r, lang));
  } catch (err) {
    log(`article failed: ${err.message}`);
    say(renderArticleFailure({ error: err.message }, lang));
  }
  return true;
}
