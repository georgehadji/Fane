// The plain search path (`vane "question"`) against a real HTTP server on a free port: no global fetch mock, so the
// request, the retry, the NDJSON reader and the timeout run as they do against Vane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

for (const k of ['VANE_URL', 'VANE_CHAT_MODEL', 'VANE_EMBEDDING_MODEL', 'VANE_CONTAINER', 'VANE_SOURCES', 'VANE_MODE']) delete process.env[k];
const { search, resolveChatModel, resolveModel, getProvidersStartingVane, UsageError } = await import('../client.mjs');

const providers = [{ id: 'p1', name: 'Openrouter', chatModels: [{ key: 'google/gemini-x', name: 'Gemini X' }, { key: 'anthropic/claude-y', name: 'Claude Y' }], embeddingModels: [{ key: 'emb-1', name: 'Embedding 1' }] }];
const SOURCE = { content: 'page text', metadata: { title: 'A page', url: 'https://a.example' } };

// handler(req, res, n) answers the n-th request (1-based); .seen holds what the server received.
async function withServer(handler, fn) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, body: body && JSON.parse(body) });
    handler(req, res, seen.length);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, seen); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}

const opts = (url, over = {}) => ({ url, model: 'google/gemini-x', embedding: 'emb-1', sources: ['web'], mode: 'speed', query: 'q', stream: false, timeoutMs: 5000, ...over });

async function captureStdout(fn) {
  const write = process.stdout.write, out = [];
  // the test runner reports over this stream in Buffers: only the strings the code under test prints are captured
  process.stdout.write = (s, ...rest) => (typeof s === 'string' ? (out.push(s), true) : write.call(process.stdout, s, ...rest));
  try { return { result: await fn(), out: out.join('') }; } catch (err) { return { error: err, out: out.join('') }; } finally { process.stdout.write = write; }
}

test('a plain search posts the chosen models and returns the answer with its sources', async () => {
  await withServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: 'Hello [1]', sources: [SOURCE] })); }, async (url, seen) => {
    const r = await search(opts(url, { instructions: 'Be brief.' }), providers);
    assert.deepEqual([r.model, r.message, r.sources], ['google/gemini-x', 'Hello [1]', [{ title: 'A page', url: 'https://a.example', content: 'page text' }]]);
    assert.equal(seen[0].url, '/api/search');
    assert.deepEqual(seen[0].body.chatModel, { providerId: 'p1', key: 'google/gemini-x' });
    assert.deepEqual([seen[0].body.embeddingModel.key, seen[0].body.optimizationMode, seen[0].body.query, seen[0].body.stream, seen[0].body.systemInstructions], ['emb-1', 'speed', 'q', false, 'Be brief.']);
  });
});

test('a 5xx is retried once; a 4xx is not and says why', async () => {
  await withServer((req, res, n) => { if (n === 1) { res.statusCode = 503; return res.end('busy'); } res.end(JSON.stringify({ message: 'ok', sources: [] })); }, async (url, seen) => {
    assert.equal((await search(opts(url), providers)).message, 'ok');
    assert.equal(seen.length, 2);
  });
  await withServer((req, res) => { res.statusCode = 400; res.end('bad model'); }, async (url, seen) => {
    await assert.rejects(search(opts(url), providers), /Search failed: HTTP 400 bad model/);
    assert.equal(seen.length, 1);
  });
});

test('a search that outlasts --timeout says so and names the model', async () => {
  await withServer(() => { /* never answers */ }, async (url) => {
    await assert.rejects(search(opts(url, { timeoutMs: 100 }), providers), /timed out after 0\.1s \(model google\/gemini-x\)/);
  });
});

const ndjson = (...events) => events.map(e => `${JSON.stringify(e)}\n`).join('');

test('--stream: tokens are printed as they arrive and the result holds the whole answer', async () => {
  await withServer((req, res) => {
    res.write(ndjson({ type: 'init', data: 'x' }, { type: 'sources', data: [SOURCE] }, { type: 'response', data: 'Hel' }));
    res.end(ndjson({ type: 'response', data: 'lo' }, { type: 'done' }));
  }, async (url) => {
    const { result, out } = await captureStdout(() => search(opts(url, { stream: true }), providers));
    assert.deepEqual([result.message, result.streamed, result.sources.length], ['Hello', true, 1]);
    assert.equal(out, 'Hello\n');
  });
});

test('--stream: a stream cut in the middle of a line says so, and what was printed stays', async () => {
  await withServer((req, res) => { res.end(`${ndjson({ type: 'response', data: 'Hel' })}{"type":"respo`); }, async (url) => {
    const { error, out } = await captureStdout(() => search(opts(url, { stream: true }), providers));
    assert.match(error.message, /Vane closed the stream in the middle of the answer/);
    assert.equal(out, 'Hel');
  });
});

test('--stream: a stream that ends cleanly without a done event is cut too, and what was printed stays', async () => {
  await withServer((req, res) => { res.end(ndjson({ type: 'init', data: 'x' }, { type: 'response', data: 'Hel' })); }, async (url) => {
    const { error, out } = await captureStdout(() => search(opts(url, { stream: true }), providers));
    assert.match(error.message, /Vane closed the stream in the middle of the answer/);
    assert.equal(out, 'Hel');
  });
});

test('--stream: a done event with no newline after it still ends the answer', async () => {
  await withServer((req, res) => { res.end(`${ndjson({ type: 'response', data: 'Hi' })}{"type":"done"}`); }, async (url) => {
    const { result, out } = await captureStdout(() => search(opts(url, { stream: true }), providers));
    assert.deepEqual([result.message, out], ['Hi', 'Hi\n']);
  });
});

test('a search whose connection is reset is retried once', async () => {
  await withServer((req, res, n) => { if (n === 1) return req.socket.destroy(); res.end(JSON.stringify({ message: 'ok', sources: [] })); }, async (url, seen) => {
    assert.equal((await search(opts(url), providers)).message, 'ok');
    assert.equal(seen.length, 2);
  });
});

test('--stream: an error event from Vane is the error', async () => {
  await withServer((req, res) => { res.end(ndjson({ type: 'response', data: 'a' }, { type: 'error', data: 'model refused' })); }, async (url) => {
    const { error } = await captureStdout(() => search(opts(url, { stream: true }), providers));
    assert.match(error.message, /Vane error: model refused/);
  });
});

test('model names: exact key, exact name, unique substring; an unknown or ambiguous name is a usage error', async () => {
  assert.equal(resolveModel(providers, 'chatModels', 'anthropic/claude-y').providerId, 'p1');
  assert.equal(resolveModel(providers, 'chatModels', 'claude y').key, 'anthropic/claude-y');
  assert.equal(resolveModel(providers, 'chatModels', 'gemini').key, 'google/gemini-x');
  assert.throws(() => resolveModel(providers, 'chatModels', '/'), (e) => e instanceof UsageError && !e.noMatch); // ambiguous
  assert.throws(() => resolveModel(providers, 'chatModels', 'nonexistent'), (e) => e instanceof UsageError && e.noMatch);
  // resolveChatModel: a known model needs no registration (the list comes back as it was)
  const r = await resolveChatModel(providers, { model: 'google/gemini-x', url: 'http://127.0.0.1:9' });
  assert.deepEqual([r.model.key, r.providers === providers], ['google/gemini-x', true]);
  // an unknown name that is not an OpenRouter slug is the usage error, with no network call
  await assert.rejects(resolveChatModel(providers, { model: 'nonexistent', modelExplicit: true, url: 'http://127.0.0.1:9' }), UsageError);
});

// ---- start-and-wait (Vane stopped: start the container once, then poll until it answers) ----

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
// a fake clock: sleep() moves time on, so the deadline is reached without waiting
function fakeClock() {
  let t = 0;
  return { now: () => t, wait: async (ms) => { t += ms; } };
}
async function quietStderr(fn) {
  const write = process.stderr.write, out = [];
  process.stderr.write = (s, ...rest) => (typeof s === 'string' ? (out.push(s), true) : write.call(process.stderr, s, ...rest));
  try { return { result: await fn(), out: out.join('') }; } catch (err) { return { error: err, out: out.join('') }; } finally { process.stderr.write = write; }
}

test('start-and-wait: unreachable, the container is started, then ready after two failed polls', async () => {
  const calls = { exec: [], providers: 0, wait: [] };
  const deps = {
    exec: (...args) => calls.exec.push(args),
    providers: async () => { if (++calls.providers < 4) throw refused(); return providers; },
    wait: async (ms) => { calls.wait.push(ms); },
    now: () => 0, waitMs: 90_000,
  };
  const { result, out } = await quietStderr(() => getProvidersStartingVane('http://127.0.0.1:3000', 'vane', deps));
  assert.deepEqual(result, providers);
  assert.deepEqual(calls.exec, [['docker', ['start', 'vane'], { stdio: 'ignore', timeout: 60_000 }]]);
  assert.equal(calls.providers, 4);
  assert.deepEqual(calls.wait, [2000, 2000, 2000]);
  assert.match(out, /Vane not reachable at http:\/\/127\.0\.0\.1:3000; starting container "vane"/);
});

test('start-and-wait: Vane answers at once, so the container is not started', async () => {
  const exec = [];
  const result = await getProvidersStartingVane('http://x', 'vane', { exec: (...a) => exec.push(a), providers: async () => providers });
  assert.deepEqual([result, exec], [providers, []]);
});

test('start-and-wait: gave up after the deadline, and says how long it waited', async () => {
  const clock = fakeClock();
  let polls = 0;
  const deps = { exec: () => {}, providers: async () => { polls++; throw refused(); }, ...clock, waitMs: 5000 };
  const { error } = await quietStderr(() => getProvidersStartingVane('http://x', 'vane', deps));
  assert.match(error.message, /Vane did not become ready within 5s/);
  assert.equal(polls, 4); // one poll before the wait, then at 2 s, 4 s and 6 s: the 4 s check is still before the 5 s deadline
});

test('start-and-wait: a container that cannot be started is an error, and Vane is not polled', async () => {
  let polls = 0;
  const deps = { exec: () => { throw new Error('no docker'); }, providers: async () => { polls++; throw refused(); } };
  const { error } = await quietStderr(() => getProvidersStartingVane('http://x', 'vane', deps));
  assert.match(error.message, /Could not start Docker container "vane"\. Is Docker Desktop running\?/);
  assert.equal(polls, 1);
});

test('start-and-wait: an error that is not a connection error is thrown as it is, with no start', async () => {
  const exec = [];
  const deps = { exec: (...a) => exec.push(a), providers: async () => { throw new Error('GET /api/providers failed: HTTP 500'); } };
  await assert.rejects(getProvidersStartingVane('http://x', 'vane', deps), /HTTP 500/);
  assert.deepEqual(exec, []);
});
