// Article writing inside Vane's web UI. patches/patch-article-chat.js calls handleArticleRequest()
// from Vane's chat route, next to the image hook: a request like "write an article about ..." or
// "γράψε ένα άρθρο για ..." is answered with a cited article instead of a short text answer, by the
// same pipeline as `vane --article`. Sources come from Vane's own research (`research`, provided by
// the patch: Vane's research class run on the user's chosen model and mode, so its progress shows in
// the answer as usual); the writing runs on OpenRouter with the key of Vane's own provider settings,
// on the models of the mode's price band (selectChains over trial.json), or on freellmapi (withFreeLlm).
// Vane's mode picks the phases: Speed = outline and draft, Balanced adds checks and edits, Quality
// adds the audit. The answer is one block, updated as the work goes: status lines, then the draft
// as soon as it exists, then the finished article.
import { readFile } from 'node:fs/promises';
import { openRouterClientFromVane, openRouterNeeded, withFreeLlm } from '../image/openrouter.mjs';
import { isImageRequest } from '../image/intent.mjs';
import { escapeHtml, previousAnswer, quiet, tagged } from '../image/present.mjs';
import { buildTextCatalogue, selectChains } from './catalogue.mjs';
import { createArticleEditor, isArticleEdit, parseArticleAnswer, targetLanguage } from './edit.mjs';
import { articleTopic, isArticleRequest, parseArticleOptions, postPlatform, postTopic } from '../core/intent-article.mjs';
import { LANGUAGE_NAMES, detectLanguage } from '../core/language.mjs';
import { DEFAULT_MODE, MODES, chainsFor } from './models.mjs';
import { beginRun } from '../core/runlog.mjs';
import { createArticlePipeline } from './pipeline.mjs';
import { prompts } from './prompts.mjs';
import { renderArticleFailure, renderArticleProgress, renderArticleResult, renderPostResult } from './present.mjs';
import { retryEmpty } from './research.mjs';

const TRIAL_FILE = new URL('./trial.json', import.meta.url);

// research(query) -> [{ title, url, content }] (Vane's research on this chat's model and mode).
// researchDone() closes Vane's research display. emit(markdown) -> blockId, update(blockId, markdown).
// lastAnswer() -> text of the previous answer, history -> the browser's chat history (see previousAnswer).
// Returns false when the message is neither an article request nor an edit of the article the previous
// answer was (Vane then answers as usual). client, trial, pipeline and editor are injectable for tests.
export async function handleArticleRequest(query, { emit, update, configPath, mode, history, lastAnswer, research, researchDone = () => {}, log = (m) => console.log(`fane: ${m}`), readConfig, signal, client, trial, pipeline, editor } = {}) {
  // A social post ("write a LinkedIn post about ...") before an article: «ανάρτηση» matches both.
  const platform = postPlatform(query);
  // A follow-up edit: the message reads like one ("shorter", "rewrite the intro") and the answer before it is an article of ours.
  let earlier = null;
  if (!platform && !isArticleRequest(query)) {
    if (isImageRequest(query) || !isArticleEdit(query)) return false;
    earlier = parseArticleAnswer(await previousAnswer(history, lastAnswer));
    // Vane's own answers have a "# " title too; ours end with a sources list (the CLI's --edit-article asks the same)
    if (!earlier?.sources.length) return false;
  }
  const topic = earlier ? query : platform ? postTopic(query) : articleTopic(query);
  // the whole request, not the topic: "γράψε ένα άρθρο για το iPhone 17" is Greek although its topic is mostly Latin letters
  const lang = earlier ? targetLanguage(query, earlier.lang) : detectLanguage(query);
  const track = beginRun(platform ? 'post' : earlier ? 'article-edit' : 'article', log, prompts);
  log = track.log;
  const state = { lang, phases: [], running: earlier ? 'edit' : 'sources', draft: null };
  const id = emit(tagged(renderArticleProgress(state)));
  const say = (markdown) => { try { update(id, tagged(markdown)); } catch (err) { log(`could not update the answer: ${err.message}`); } };
  try {
    client ??= await openRouterClientFromVane({ configPath, readConfig, log, signal });
    if (!client) {
      say(quiet([escapeHtml(openRouterNeeded('Article writing', { free: true }))]));
      return true;
    }
    trial ??= JSON.parse(await readFile(TRIAL_FILE, 'utf8')).models || {};
    const useMode = MODES.includes(mode) ? mode : DEFAULT_MODE;
    const chosen = await withFreeLlm(client, useMode, async () => selectChains(buildTextCatalogue(await client.models()), trial, { mode: useMode, lang }), chainsFor);
    if (!chosen) {
      say(quiet([escapeHtml(`No text model has passed the trial for ${LANGUAGE_NAMES[lang]}: run node scripts/article-trial.mjs, or ask in English.`)]));
      return true;
    }
    const retrieve = retryEmpty(research);
    if (earlier) {
      const edit = editor || createArticleEditor({ client, log });
      const onEdit = (e) => {
        if (e.phase === 'sources' && e.status === 'done') researchDone();
        if (e.status === 'running') { state.running = e.phase; say(renderArticleProgress(state)); }
      };
      const r = await edit({ body: earlier.body, sources: earlier.sources, instruction: query, lang, mode: useMode, chains: chosen.chains, prices: chosen.prices, retrieve, onProgress: onEdit });
      say(r.ok ? renderArticleResult(r) : renderArticleFailure({ ...r, edit: true }, lang));
      track.finish(r);
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
    const r = await write({ topic, mode: useMode, lang, words: parseArticleOptions(query, { post: !!platform }).words, format: platform || 'article', chains: chosen.chains, prices: chosen.prices, onProgress });
    await queue;
    say(!r.ok ? renderArticleFailure({ ...r, post: !!platform }, lang) : platform ? renderPostResult(r) : renderArticleResult(r));
    track.finish(r);
  } catch (err) {
    log(`${platform ? 'post' : 'article'} failed: ${err.message}`);
    say(renderArticleFailure({ error: err.message, post: !!platform }, lang));
    track.finish({ ok: false });
  }
  return true;
}
