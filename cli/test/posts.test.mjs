// Social posts (cli/core/formats.mjs): intent, checks, the pipeline's post format, the web answer and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { POSTS, clampPostWords } = await import('../core/formats.mjs');
const { isArticleRequest, parseArticleOptions, postPlatform, postTopic } = await import('../core/intent-article.mjs');
const { firstComment, postChecks, runChecks, stripCitations } = await import('../write/checks.mjs');
const { createArticlePipeline } = await import('../write/pipeline.mjs');
const { renderPostResult } = await import('../write/present.mjs');
const { handleArticleRequest } = await import('../write/vane-hook.mjs');
const { autoRoute, parseCli } = await import('../vane.mjs');

const SOURCES = [
  { title: 'Tidal energy in Orkney', url: 'https://example.org/a', content: 'The Orkney site supplied 1,200 homes in 2023.' },
  { title: 'Costs of marine power', url: 'https://example.org/b', content: 'Costs fell by 40% between 2015 and 2023.' },
];

test('a post request names its platform, or gets LinkedIn; a blog post stays an article; a question stays a search', () => {
  const cases = [
    ['write a LinkedIn post about tidal power in Orkney', 'linkedin', 'tidal power in Orkney'],
    ['Draft a post for Facebook on heat pumps', 'facebook', 'heat pumps'],
    ['write me a 90-word facebook post about bees', 'facebook', 'bees'],
    ['write a post about tides, for LinkedIn', 'linkedin', 'tides'],
    ['write a short post about GLP-1 drugs', 'linkedin', 'GLP-1 drugs'],
    ['Γράψε μια ανάρτηση για το LinkedIn για την ωκεάνια ενέργεια', 'linkedin', 'την ωκεάνια ενέργεια'],
    ['γράψε μου ένα ποστ στο Facebook σχετικά με τη λειψυδρία', 'facebook', 'τη λειψυδρία'],
  ];
  for (const [q, platform, topic] of cases) {
    assert.equal(postPlatform(q), platform, q);
    assert.equal(postTopic(q), topic, q);
  }
  for (const q of ['Δημιούργησε μια ανάρτηση για το blog μου', 'write a blog post on AI', 'write an article about LinkedIn', 'how long should a LinkedIn post be?', 'write an update on the project for my manager']) assert.equal(postPlatform(q), null, q);
  assert.equal(postPlatform('write a LinkedIn update about our launch'), 'linkedin');
  assert.equal(postTopic('write a LinkedIn update about our launch'), 'our launch');
  assert.ok(isArticleRequest('Δημιούργησε μια ανάρτηση για το blog μου'));
  assert.equal(parseArticleOptions('a 90-word post', { post: true }).words, 90);
  assert.equal(parseArticleOptions('a 90-word post').words, undefined); // articles read 3-4 digits only
  assert.equal(clampPostWords(5, 'linkedin'), POSTS.linkedin.minWords);
  assert.equal(clampPostWords(undefined, 'facebook'), POSTS.facebook.words);
});

test('post checks: fake bold fails, the hook past the fold, Markdown, a link and too many hashtags warn', () => {
  const names = (post, p = 'linkedin') => postChecks(post, p).filter(i => i.level !== 'ok').map(i => `${i.name}:${i.level}`);
  assert.deepEqual(names('Orkney supplied 1,200 homes from the tide.\n\nCosts fell by 40%.'), []);
  assert.deepEqual(names('𝗢𝗿𝗸𝗻𝗲𝘆 supplied 1,200 homes.'), ['fake-bold:fail']);
  assert.deepEqual(names(`${'Tide power '.repeat(25)}\n\nMore.`), ['hook:warn']);
  assert.deepEqual(names('Orkney.\n\n**Costs** fell.'), ['markdown:warn']);
  assert.deepEqual(names('Orkney.\n\nRead https://example.org/a'), ['link-in-post:warn']);
  assert.deepEqual(names('Orkney.\n\n#tides #energy #orkney #scotland'), ['hashtags:warn']);
  assert.deepEqual(names('Orkney.\n\n#tides', 'facebook'), ['hashtags:warn']); // Facebook: none
  assert.deepEqual(names('x'.repeat(3001)), ['post-length:fail', 'hook:warn']);
  // runChecks adds them for a post, and drops the article's title warning
  const r = runChecks('Orkney supplied 1,200 homes in 2023 [1].', { sources: SOURCES, targetWords: 60, format: 'linkedin' });
  assert.ok(r.items.some(i => i.name === 'post-length') && !r.items.some(i => i.name === 'title'));
});

test('a published post has no [n] markers; its sources become a plain first comment', () => {
  assert.equal(stripCitations('Orkney supplied 1,200 homes [1]. Costs fell by 40% [1, 2].\n\nTides are predictable [2–3].'), 'Orkney supplied 1,200 homes. Costs fell by 40%.\n\nTides are predictable.');
  assert.equal(firstComment(SOURCES, 'en'), 'Sources:\n1. Tidal energy in Orkney: https://example.org/a\n2. Costs of marine power: https://example.org/b');
  assert.match(firstComment(SOURCES, 'el'), /^Πηγές:\n1\. /);
  assert.equal(firstComment([], 'en'), '');
});

// A model that answers each role of the post pipeline.
const POST_TEXT = 'Orkney\'s tidal site supplied 1,200 homes in 2023 [1].\n\nCosts fell by 40% between 2015 and 2023 [2].\n\nThat is what predictable power looks like.';
function fakeClient({ verdict = 'supported' } = {}) {
  const calls = [];
  const roleOf = (s) => (/posts that share researched facts/.test(s) ? 'draft' : /adversarial fact-checker/.test(s) ? 'factcheck' : /developmental editor/.test(s) ? 'revise' : /style and copy editor/.test(s) ? 'polish' : /revising a finished article/.test(s) ? 'rewrite' : /web search queries/.test(s) ? 'queries' : 'other');
  const answers = {
    draft: POST_TEXT, revise: POST_TEXT, polish: POST_TEXT, rewrite: POST_TEXT,
    factcheck: JSON.stringify({ claims: [{ claim: '1,200 homes', source: 1, verdict: 'supported' }, { claim: '40%', source: 2, verdict }] }),
    queries: JSON.stringify({ queries: ['tidal power Orkney'] }),
  };
  return {
    calls,
    chat: async (body) => {
      const role = roleOf(body.messages[0].content);
      calls.push({ role, body });
      return { choices: [{ message: { content: answers[role] || '' }, finish_reason: 'stop' }], usage: { cost: 0.001 } };
    },
  };
}
const write = (client, opts) => createArticlePipeline({ client, retrieve: async () => SOURCES })({ topic: 'tidal power in Orkney', ...opts });

test('a LinkedIn post on Speed is one draft call; the result is the post, a first comment and post checks', async () => {
  const c = fakeClient();
  const r = await write(c, { format: 'linkedin', mode: 'speed' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(c.calls.map(x => x.role), ['draft']);
  const draft = c.calls[0].body.messages[1].content;
  assert.match(draft, new RegExp(`under ${POSTS.linkedin.foldChars} characters`));
  assert.match(draft, /about 220 words/);
  assert.match(c.calls[0].body.messages[0].content, /LinkedIn posts/);
  assert.equal(r.format, 'linkedin');
  assert.doesNotMatch(r.post, /\[\d/);
  assert.match(r.post, /^Orkney's tidal site supplied 1,200 homes in 2023\./);
  assert.equal(r.comment, firstComment(SOURCES, 'en'));
  assert.ok(r.article.startsWith(r.post) && r.article.includes(r.comment));
  assert.equal(r.title, '');
  assert.ok(r.checks.items.some(i => i.name === 'post-length'));
});

test('a post on Balanced: fact-check and polish, a revision only when a claim failed, and every editor keeps the post shape', async () => {
  const clean = fakeClient();
  await write(clean, { format: 'facebook', mode: 'balanced' });
  assert.deepEqual(clean.calls.map(x => x.role), ['draft', 'factcheck', 'polish']);
  const polish = clean.calls.find(x => x.role === 'polish').body.messages[1].content;
  assert.match(polish, /Shape to keep:/);
  assert.match(polish, /This is a Facebook post/);
  assert.match(polish, /No hashtags\./);
  const failed = fakeClient({ verdict: 'unsupported' });
  await write(failed, { format: 'facebook', mode: 'quality' });
  assert.deepEqual(failed.calls.map(x => x.role), ['draft', 'factcheck', 'revise', 'polish']); // no outline, critique or audit
  assert.match(failed.calls.find(x => x.role === 'revise').body.messages[1].content, /Shape to keep:/);
});

test('an unknown format is a programming error', async () => {
  await assert.rejects(write(fakeClient(), { format: 'tiktok' }), /unknown format "tiktok"/);
});

const RESULT = {
  ok: true, format: 'linkedin', language: 'en', mode: 'balanced', post: 'Orkney supplied 1,200 homes <b>in 2023</b>.\nA second line.\n\nCosts fell by 40%.', sources: SOURCES, comment: firstComment(SOURCES, 'en'),
  cost: 0.012, ms: 42_000, degraded: [], checks: { items: [{ name: 'hook', level: 'warn', detail: 'long' }] }, words: 14,
};

test('the web answer shows the post as plain paragraphs, the first comment with links, and the length against the fold', () => {
  const html = renderPostResult(RESULT);
  assert.ok(html.startsWith('<p>Orkney supplied 1,200 homes in 2023.<br>A second line.</p>\n<p>Costs fell by 40%.</p>'));
  assert.match(html, /\*\*First comment\*\*\n\n<p>Sources:<br>1\. Tidal energy in Orkney: https:\/\/example\.org\/a<br>2\. /); // URLs written out, ready to paste
  assert.match(html, /LinkedIn · \d+ characters · \d+ shown before “see more” · 2 sources · ≈ \$0\.012/);
  assert.match(html, /hook: long/);
  assert.doesNotMatch(html, /[¹²]/); // no citation links in a post
  assert.match(renderPostResult({ ...RESULT, language: 'el' }), /Πρώτο σχόλιο/);
});

test('the web hook writes a post for a LinkedIn request and an article for a blog post', async () => {
  const seen = [];
  const blocks = new Map();
  const ui = { emit: (x) => { blocks.set('b1', x); return 'b1'; }, update: (id, x) => blocks.set(id, x) };
  const TRIAL = { 'alpha/m1': { en: { ok: true, score: 1 }, el: { ok: true, score: 1 }, json: { ok: true } } };
  const client = { models: async () => [{ id: 'alpha/m1', name: 'M1', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.0000001', completion: '0.0000004' }, context_length: 100000 }] };
  const pipeline = async (args) => { seen.push(args); return args.format === 'article' ? { ok: false, error: 'stop here' } : RESULT; };
  assert.equal(await handleArticleRequest('write a 90-word LinkedIn post about tidal power', { ...ui, mode: 'balanced', client, trial: TRIAL, research: async () => SOURCES, pipeline }), true);
  assert.deepEqual([seen[0].format, seen[0].topic, seen[0].words], ['linkedin', 'tidal power', 90]);
  assert.match(blocks.get('b1'), /\*\*First comment\*\*/);
  await handleArticleRequest('Δημιούργησε μια ανάρτηση για το blog μου', { ...ui, mode: 'balanced', client, trial: TRIAL, research: async () => SOURCES, pipeline });
  assert.equal(seen[1].format, 'article');
});

test('the CLI: --post validates the platform and its own word range, and a post request is routed there', () => {
  assert.equal(parseCli(['tides', '--post', 'LinkedIn']).post, 'linkedin');
  assert.equal(parseCli(['tides', '--post', 'linkedin']).article, true);
  assert.equal(parseCli(['tides', '--post', 'facebook', '--words', '40']).words, 40); // below an article's 300
  assert.throws(() => parseCli(['tides', '--post', 'tiktok']), /Invalid --post/);
  assert.throws(() => parseCli(['tides', '--post', 'linkedin', '--words', '900']), /Invalid --words "900" \(60-450\)/);
  const route = (...argv) => autoRoute(parseCli(argv), argv);
  assert.equal(route('write a Facebook post about heat pumps').post, 'facebook');
  assert.equal(route('γράψε μια ανάρτηση για τη λειψυδρία').post, 'linkedin');
  assert.equal(route('write a Facebook post about heat pumps', '--no-auto-article'), null);
  assert.equal(route('write an article about heat pumps').post, undefined);
});
