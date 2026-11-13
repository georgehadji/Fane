// Follow-up edits of a social post in Vane's chat: the platform mark, parsePostAnswer, the editor's post format, the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { POST_MARK, postMark } = await import('../core/formats.mjs');
const { firstComment } = await import('../write/checks.mjs');
const { createArticleEditor, parseArticleAnswer, parsePostAnswer } = await import('../write/edit.mjs');
const { renderArticleFailure, renderPostResult } = await import('../write/present.mjs');
const { handleArticleRequest } = await import('../write/vane-hook.mjs');
const { ANSWER_MARKER, tagged } = await import('../image/present.mjs');

const SOURCES = [
  { title: 'Tidal energy in Orkney: a review', url: 'https://example.org/a', content: '' },
  { title: 'Costs of marine power', url: 'https://example.org/b', content: '' },
];
const POST = 'Orkney tidal turbines supplied about 1,200 homes in 2023 & the crews kept them running all winter long.\n\nCosts of marine power fell by 40% between 2015 and 2023, which changes what a small island grid can afford to build next.\n\nThe next step is a second array, with more "tidal" turbines.';
const RESULT = {
  ok: true, format: 'linkedin', language: 'en', mode: 'balanced', post: POST, sources: SOURCES, comment: firstComment(SOURCES, 'en'),
  cost: 0.012, ms: 42_000, degraded: [], checks: { ok: true, items: [{ name: 'hook', level: 'warn', detail: 'long' }] }, words: 50,
};
const answer = (over = {}) => tagged(renderPostResult({ ...RESULT, ...over }));

test('a post answer carries its platform mark, and the mark is the only way to read it back', () => {
  assert.ok(renderPostResult(RESULT).includes(postMark('linkedin')));
  assert.equal(POST_MARK.exec(answer({ format: 'facebook' }))[1], 'facebook');
  assert.equal(parsePostAnswer(answer().replace(postMark('linkedin'), '')), null);
  assert.equal(parseArticleAnswer(answer()), null); // no "# " title: the article reader never took it
});

test('parsePostAnswer: the post text, its sources from the first comment, the platform and the language', () => {
  const p = parsePostAnswer(answer());
  assert.equal(p.format, 'linkedin');
  assert.equal(p.body, POST); // paragraphs kept, & and quotes unescaped
  assert.deepEqual(p.sources.map(s => [s.title, s.url]), SOURCES.map(s => [s.title, s.url])); // a title with a colon survives
  assert.equal(p.lang, 'en');
  assert.equal(parsePostAnswer(answer({ language: 'el', post: 'Οι παλιρροϊκές τουρμπίνες στο Όρκνεϊ τροφοδότησαν περίπου 1.200 σπίτια το 2023 και λειτούργησαν όλο τον χειμώνα χωρίς διακοπή, με χαμηλότερο κόστος από ό,τι πριν.' })).lang, 'el');
});

test('parsePostAnswer: a post without a first comment has no sources, and a stub is not a post', () => {
  const p = parsePostAnswer(answer({ sources: [], comment: '' }));
  assert.deepEqual(p.sources, []);
  assert.equal(p.body, POST);
  assert.equal(parsePostAnswer(answer({ post: 'Too short.' })), null);
  assert.equal(parsePostAnswer(''), null);
  assert.equal(parsePostAnswer(`some answer ${postMark('tiktok')} ${ANSWER_MARKER}`), null); // an unknown platform
});

function editClient(text) {
  const calls = [];
  return { calls, chat: async (body) => { calls.push(body.messages); return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { cost: 0.002 } }; } };
}
const CHAINS = { draft: ['alpha/m1'] };

test('the editor edits a post as plain text: no title check, no citations, sources kept', async () => {
  const shorter = 'Orkney tidal turbines supplied about 1,200 homes in 2023 [1] and kept running all winter.\n\nCosts fell by 40% between 2015 and 2023 [2], which changes what a small grid can build next, and why the next array matters.';
  const client = editClient(shorter);
  const edit = createArticleEditor({ client });
  const r = await edit({ body: POST, sources: SOURCES, instruction: 'make it shorter', lang: 'en', format: 'linkedin', mode: 'speed', chains: CHAINS, prices: {} });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'linkedin');
  assert.doesNotMatch(r.post, /\[\d/); // [n] markers stripped
  assert.equal(r.comment, firstComment(SOURCES, 'en'));
  assert.deepEqual(r.sources, SOURCES);
  const [system, user] = client.calls[0].map(m => m.content);
  assert.match(system, /LinkedIn post/);
  assert.match(user, /<post>/);
  assert.match(user, /Shape to keep:/);
  assert.doesNotMatch(user, /# title|\[n\] citation/);
  assert.match(renderPostResult(r), /<p>Orkney tidal turbines/); // shown as a post again
});

test('a post edit that asks for new facts does not search, and says so', async () => {
  let searched = 0;
  const edit = createArticleEditor({ client: editClient(POST.replace('next step', 'following step')) });
  const r = await edit({ body: POST, sources: SOURCES, instruction: 'add a line about costs', lang: 'en', format: 'linkedin', chains: CHAINS, prices: {}, retrieve: async () => { searched++; return []; } });
  assert.equal(searched, 0);
  assert.ok(r.degraded.some(d => /no new search/.test(d)));
});

test('a post edit that loses most of the text is refused, and the failure says the post, not the article', async () => {
  const edit = createArticleEditor({ client: editClient('Short.') });
  const r = await edit({ body: POST, sources: SOURCES, instruction: 'make it shorter', lang: 'en', format: 'linkedin', chains: CHAINS, prices: {} });
  assert.equal(r.ok, false);
  assert.match(renderArticleFailure({ ...r, edit: true, post: true }, 'en'), /The post could not be changed/);
  assert.match(renderArticleFailure({ ...r, edit: true, post: true }, 'el'), /αλλάξω την ανάρτηση/);
});

const MODELS = [{ id: 'alpha/m1', name: 'M1', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000004' }, context_length: 100000 }];
const TRIAL = { 'alpha/m1': { en: { ok: true, tellsPerThousand: 0 }, el: { ok: true, tellsPerThousand: 0 }, json: { ok: true } } };
function ui() {
  const blocks = new Map();
  return { blocks, emit: (x) => { blocks.set('b1', x); return 'b1'; }, update: (id, x) => blocks.set(id, x) };
}

test('"make it shorter" after a post edits the post; after a plain Vane answer it is left to Vane', async () => {
  const u = ui();
  const client = { ...editClient('Orkney tidal turbines supplied about 1,200 homes in 2023 and kept running all winter.\n\nCosts fell by 40% between 2015 and 2023, which changes what a small island grid can afford to build next.'), models: async () => MODELS };
  let searched = 0;
  const handled = await handleArticleRequest('make it shorter', { ...u, mode: 'speed', client, trial: TRIAL, lastAnswer: async () => answer(), research: async () => { searched++; return []; } });
  assert.equal(handled, true);
  assert.equal(searched, 0);
  const final = u.blocks.get('b1');
  assert.match(final, /^<p>Orkney tidal turbines/);
  assert.match(final, /\*\*First comment\*\*/);
  assert.ok(final.includes(postMark('linkedin')));
  assert.ok(final.endsWith(ANSWER_MARKER));
  assert.doesNotMatch(final, /## Sources/); // not turned into an article
  // an answer that is neither an article of ours nor a post: not handled
  assert.equal(await handleArticleRequest('make it shorter', { ...ui(), mode: 'speed', client, trial: TRIAL, lastAnswer: async () => 'Canberra is the capital of Australia.', research: async () => [] }), false);
});

test('a throwing post editor is reported as a post edit', async () => {
  const u = ui(), lines = [];
  const editor = async () => { throw new Error('boom'); };
  await handleArticleRequest('make it shorter', { ...u, mode: 'speed', client: { models: async () => MODELS }, trial: TRIAL, lastAnswer: async () => answer(), research: async () => [], editor, log: (m) => lines.push(m) });
  assert.match(u.blocks.get('b1'), /The post could not be changed/);
  assert.ok(lines.some(l => /"feature":"post-edit"/.test(l)));
});
