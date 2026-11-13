import { test } from 'node:test';
import assert from 'node:assert/strict';

// DEFAULTS read the environment at import time, so clear it first.
for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { parseCli, resolveModel, findOpenRouterProvider, autoRoute, classifyProbe, probeScript, serviceRows, restartLine, LADDER_DEFAULT_URL } = await import('../vane.mjs');

test('a query routed to images or articles has its options checked as if --image/--article was typed', () => {
  const route = (...argv) => autoRoute(parseCli(argv), argv);
  assert.deepEqual(route('make an image of a fox', '--image-model', 'a/x,b/y')['image-model'], ['a/x', 'b/y']);
  assert.throws(() => route('make an image of a fox', '-n', 'abc'), /Invalid --count/);
  assert.throws(() => route('make an image of a fox', '--tier', 'bogus'), /Invalid --tier/);
  assert.deepEqual(route('write an article about tides', '--article-model', 'a/x,b/y')['article-model'], ['a/x', 'b/y']);
  assert.throws(() => route('write an article about tides', '--lang', 'de'), /Invalid --lang/);
  assert.equal(route('write an article about tides').article, true);
  assert.equal(route('make an image of a fox', '--no-auto-image'), null);
  assert.equal(route('what is tidal power'), null);
});

const providers = [
  { id: 'p1', name: 'Anthropic', chatModels: [{ key: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { key: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }], embeddingModels: [] },
  { id: 'p2', name: 'Openrouter Fane', chatModels: [{ key: 'gpt-5', name: 'GPT 5' }, { key: 'gpt-5-mini', name: 'GPT 5 Mini' }], embeddingModels: [{ key: 'emb-small', name: 'Embedding Small' }] },
];

test('parseCli defaults', () => {
  const o = parseCli(['hello', 'world']);
  assert.equal(o.query, 'hello world');
  assert.deepEqual(o.sources, ['web']);
  assert.equal(o.mode, 'speed');
  assert.equal(o.modelExplicit, false);
  assert.equal(o.timeoutMs, 180_000);
});

test('parseCli timeout depends on mode unless given', () => {
  assert.equal(parseCli(['q', '-o', 'quality']).timeoutMs, 600_000);
  assert.equal(parseCli(['q', '-o', 'quality', '-t', '90']).timeoutMs, 90_000);
  assert.equal(parseCli(['q', '-o', 'balanced']).timeoutMs, 180_000);
});

test('parseCli: --tier premium researches in quality mode, so it gets the long timeout', () => {
  for (const flag of ['--article', '--code', '--brainstorm']) {
    assert.equal(parseCli([flag, '--tier', 'premium', 'x']).timeoutMs, 600_000, flag);
    assert.equal(parseCli([flag, '--tier', 'premium', '-t', '90', 'x']).timeoutMs, 90_000, flag);
    assert.equal(parseCli([flag, '--tier', 'value', 'x']).timeoutMs, 180_000, flag);
  }
});

test('parseCli marks -m as explicit', () => {
  const o = parseCli(['q', '-m', 'gpt-5']);
  assert.equal(o.model, 'gpt-5');
  assert.equal(o.modelExplicit, true);
});

test('parseCli rejects bad input', () => {
  assert.throws(() => parseCli(['q', '-s', 'web,bogus']), /Invalid source/);
  assert.throws(() => parseCli(['q', '-o', 'turbo']), /Invalid mode/);
  assert.throws(() => parseCli(['q', '-t', '0']), /Invalid timeout/);
  assert.throws(() => parseCli(['q', '--stream', '--json']), /cannot be combined/);
});

test('resolveModel: exact key, exact name, unique partial', () => {
  assert.equal(resolveModel(providers, 'chatModels', 'gpt-5').key, 'gpt-5');
  assert.equal(resolveModel(providers, 'chatModels', 'claude haiku 5.5').key, 'claude-haiku-5-5');
  assert.equal(resolveModel(providers, 'chatModels', 'sonnet').key, 'claude-sonnet-5-5');
  assert.equal(resolveModel(providers, 'chatModels', 'gpt-5').providerId, 'p2');
});

test('resolveModel: ambiguous vs no match', () => {
  assert.throws(() => resolveModel(providers, 'chatModels', 'claude'), (e) => /Ambiguous/.test(e.message) && e.noMatch === false);
  assert.throws(() => resolveModel(providers, 'chatModels', 'openai/gpt-4o'), (e) => /Unknown chat model/.test(e.message) && e.noMatch === true);
});

test('findOpenRouterProvider', () => {
  assert.equal(findOpenRouterProvider(providers).id, 'p2');
  assert.equal(findOpenRouterProvider(providers, 'anthropic').id, 'p1');
  assert.throws(() => findOpenRouterProvider(providers, 'nope'), /No Vane provider/);
  const two = [...providers, { id: 'p4', name: 'Openrouter', chatModels: [] }];
  assert.equal(findOpenRouterProvider(two, 'Openrouter').id, 'p4'); // exact name beats substring matches
  assert.throws(() => findOpenRouterProvider([...providers, { id: 'p3', name: 'OpenRouter 2', chatModels: [] }]), /More than one/);
});

test('modeOf: an image tier decides the Vane mode, otherwise --mode does', async () => {
  const { modeOf } = await import('../runners.mjs');
  assert.equal(modeOf({ tier: 'premium', mode: 'speed' }), 'quality');
  assert.equal(modeOf({ tier: 'budget', mode: 'quality' }), 'speed');
  assert.equal(modeOf({ tier: 'value' }), 'balanced');
  assert.equal(modeOf({ mode: 'speed' }), 'speed');
  assert.equal(modeOf({ tier: undefined, mode: 'balanced' }), 'balanced');
});

test('vaneRetrieve: parallel searches share one provider fetch and one model registration; a failure is retried', async () => {
  const { vaneRetrieve } = await import('../runners.mjs');
  const calls = { fetch: 0, resolve: 0, search: [] };
  const deps = {
    getProviders: async () => { calls.fetch++; await new Promise(r => setTimeout(r, 10)); return ['raw']; },
    resolve: async (list) => { calls.resolve++; return { model: {}, providers: [...list, 'registered'] }; },
    search: async (o, providers) => { calls.search.push([o.query, providers.join('+')]); return { sources: [{ title: 'a', url: 'https://a.example', content: 'x' }] }; },
  };
  const retrieve = vaneRetrieve({ url: 'http://x', model: 'a/b' }, 'balanced', deps);
  const results = await Promise.all(['one', 'two', 'three'].map(q => retrieve(q)));
  assert.deepEqual([calls.fetch, calls.resolve, results.every(r => r.length === 1)], [1, 1, true]);
  assert.deepEqual(calls.search.map(c => c[1]), ['raw+registered', 'raw+registered', 'raw+registered']); // every search sees the registered model
  await retrieve('four');
  assert.deepEqual([calls.fetch, calls.resolve], [1, 1]);
  // a failed first fetch is not remembered
  let n = 0;
  const flaky = vaneRetrieve({ url: 'http://x' }, 'speed', { ...deps, getProviders: async () => { if (++n === 1) throw new Error('Vane is down'); return ['raw']; } });
  await assert.rejects(flaky('q'), /Vane is down/);
  assert.equal((await flaky('q')).length, 1);
});

// Characterization of parseCli's single-feature behaviour (plans/state-machines.md Phase 5), before featureOf.
test('characterization: each single feature flag is kept, and --stream is refused with it', () => {
  const rows = [
    [['--image', 'a fox'], (o) => o.image === true],
    [['--article', 'tides'], (o) => o.article === true],
    [['--post', 'linkedin', 'tides'], (o) => o.post === 'linkedin'],
    [['--edit-article', 'a.md', 'shorter'], (o) => o['edit-article'] === 'a.md'],
    [['--code', 'a script'], (o) => o.code === true],
    [['--brainstorm', 'ideas'], (o) => o.brainstorm === true],
    [['--list-article-models'], (o) => o['list-article-models'] === true],
    [['--list-code-models'], (o) => o['list-code-models'] === true],
  ];
  for (const [argv, kept] of rows) {
    assert.ok(kept(parseCli(argv)), argv.join(' '));
    assert.throws(() => parseCli([...argv, '--stream']), /--stream does not apply to --/, argv.join(' '));
  }
});

test('characterization: options are checked per single feature', () => {
  for (const argv of [['--image', 'x'], ['--article', 'x'], ['--code', 'x'], ['--brainstorm', 'x']]) {
    assert.throws(() => parseCli([...argv, '--tier', 'bogus']), /Invalid --tier/, argv[0]);
  }
  assert.throws(() => parseCli(['--article', 'x', '--lang', 'de']), /Invalid --lang/);
  assert.throws(() => parseCli(['--brainstorm', 'x', '--lang', 'de']), /Invalid --lang/);
  assert.throws(() => parseCli(['--image', 'x', '--reasoning', 'high']), /--reasoning and --max-cost apply only/);
  assert.throws(() => parseCli(['--post', 'linkedin', 'x', '--words', '5']), /Invalid --words/);
  assert.throws(() => parseCli(['--post', 'myspace', 'x']), /Invalid --post/);
});

test('featureOf: one feature flag per call; two or more is a UsageError naming them', async () => {
  const { UsageError } = await import('../client.mjs');
  const { featureOf } = await import('../vane.mjs');
  const feature = (...argv) => featureOf(parseCli(argv));
  const rows = [
    [['--image', 'a fox'], 'image'],
    [['--article', 'tides'], 'article'],
    [['--post', 'linkedin', 'tides'], 'article'], // a post counts once, as the article feature
    [['--edit-article', 'a.md', 'shorter'], 'edit-article'],
    [['--code', 'a script'], 'code'],
    [['--brainstorm', 'ideas'], 'brainstorm'],
    [['--list-article-models'], 'list-article'],
    [['--list-code-models'], 'list-code'],
    [['what is tidal power'], null],
    [['--list-image-models'], null], // a listing, not a feature flag
  ];
  for (const [argv, want] of rows) assert.equal(feature(...argv), want, argv.join(' '));
  const clashes = [
    [['--brainstorm', 'x', '--article'], ['--brainstorm', '--article']],
    [['--image', 'x', '--code', 'y'], ['--image', '--code']],
    [['--post', 'linkedin', 'x', '--article'], ['--post', '--article']],
    [['--article', 'x', '--edit-article', 'a.md', 'shorter'], ['--article', '--edit-article']],
    [['--code', 'x', '--brainstorm', 'y'], ['--code', '--brainstorm']],
    [['--list-code-models', '--brainstorm', 'x'], ['--list-code-models', '--brainstorm']],
    [['--image', 'x', '--list-article-models'], ['--image', '--list-article-models']],
  ];
  for (const [argv, flags] of clashes) {
    assert.throws(() => parseCli(argv), (e) => e instanceof UsageError && flags.every(f => e.message.includes(f)), argv.join(' '));
  }
});

const LADDER = { name: 'Ladder', why: 'paywalled pages are read without it', fix: 'docker start weebot-ladder' };
const FREE = { name: 'freellmapi', why: 'free models need it', fix: 'docker compose up -d', up: (s) => s === 200 };

test('classifyProbe: refused and timed out are warnings with the start command, never failures', () => {
  for (const error of ['ECONNREFUSED', 'TimeoutError']) {
    const r = classifyProbe({ error }, LADDER);
    assert.equal(r.level, 'warn');
    assert.ok(r.message.includes(error) && r.message.includes('docker start weebot-ladder'));
  }
});

test('classifyProbe: an answer is ok unless the row says that status is the wrong service', () => {
  assert.equal(classifyProbe({ status: 200 }, LADDER).level, 'ok');
  assert.equal(classifyProbe({ status: 404 }, LADDER).level, 'ok'); // a proxy's root may answer anything below 500
  assert.equal(classifyProbe({ status: 502 }, LADDER).level, 'warn');
  assert.equal(classifyProbe({ status: 200 }, FREE).level, 'ok');
  const other = classifyProbe({ status: 401 }, FREE); // the ping needs no key: 401 is another service on the port
  assert.equal(other.level, 'warn');
  assert.ok(other.message.includes('401') && other.message.includes('another service'));
});

test('serviceRows: Ladder by default, none when FANE_LADDER_URL is empty, freellmapi only with a provider', () => {
  assert.deepEqual(serviceRows({ ladderUrl: undefined, freeOrigin: null }).map(r => [r.name, r.url]), [['Ladder', LADDER_DEFAULT_URL]]);
  assert.deepEqual(serviceRows({ ladderUrl: '  ', freeOrigin: null }), []);
  assert.deepEqual(serviceRows({ ladderUrl: 'http://x:1', freeOrigin: 'http://host.docker.internal:3001' }).map(r => [r.name, r.url]),
    [['Ladder', 'http://x:1'], ['freellmapi', 'http://host.docker.internal:3001/api/ping']]);
});

test('probeScript is valid JavaScript for any address and carries the address as a string', () => {
  for (const url of ['http://host.docker.internal:9081', 'http://x/"q\'']) {
    const src = probeScript(url);
    assert.doesNotThrow(() => new Function(src));
    assert.ok(src.includes(JSON.stringify(url)));
  }
});

test('restartLine: "no" and an empty policy warn with the docker update command', () => {
  for (const policy of ['no', '']) {
    const r = restartLine('weebot-ladder', policy);
    assert.equal(r.level, 'warn');
    assert.ok(r.message.includes('docker update --restart unless-stopped weebot-ladder'));
  }
  for (const policy of ['unless-stopped', 'always', 'on-failure']) assert.equal(restartLine('vane', policy).level, 'ok');
});
