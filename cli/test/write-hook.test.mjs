import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { cleanMarkdown, renderArticleFailure, renderArticleProgress, renderArticleResult } from '../write/present.mjs';
import { handleArticleRequest } from '../write/vane-hook.mjs';
import { ANSWER_MARKER, tagged } from '../image/present.mjs';
import { sourcesSection } from '../write/checks.mjs';
import { isArticleEdit, parseArticleAnswer, targetLanguage } from '../write/edit.mjs';

const require = createRequire(import.meta.url);
const { planPatch } = require('../../patches/lib/apply-targets.js');
const { FILES, FANE_WRITE_DIR, CONFIG_JSON } = require('../../patches/lib/vane.js');

const SOURCES = [
  { title: 'Tidal energy in Orkney', url: 'https://example.org/a', content: 'The Orkney site supplied 1,200 homes.' },
  { title: 'Costs of marine power', url: 'https://example.org/b', content: 'Costs fell by 40%.' },
  { title: 'Wind versus tide', url: 'https://example.org/c', content: 'Tides are predictable.' },
];

// ---- presenters ----

test('cleanMarkdown removes HTML tags and keeps Markdown and plain angle brackets', () => {
  assert.equal(cleanMarkdown('# T\n\nA <img src=x onerror=alert(1)> b <script>x</script> and 3 < 4 > 2 **bold**'), '# T\n\nA  b x and 3 < 4 > 2 **bold**');
  assert.equal(cleanMarkdown('<!-- hidden -->text'), 'text');
});

test('progress without a draft is one status paragraph, in the language of the article', () => {
  const en = renderArticleProgress({ lang: 'en', phases: [{ phase: 'sources', status: 'done' }, { phase: 'outline', status: 'ok' }], running: 'draft', draft: null });
  assert.match(en, /^<p role="status"/);
  assert.match(en, /Writing the draft…/);
  assert.match(en, /Researching sources · Planning the outline/);
  const el = renderArticleProgress({ lang: 'el', phases: [], running: 'sources', draft: null });
  assert.match(el, /Αναζήτηση πηγών…/);
});

test('progress with a draft shows it numbered from 1 with its sources, above the status', () => {
  const html = renderArticleProgress({ lang: 'en', phases: [{ phase: 'draft', status: 'ok' }], running: 'factcheck', draft: { text: '# Tides\n\nCosts fell [3]. Homes [1].', sources: SOURCES } });
  assert.ok(html.startsWith('# Tides\n\nCosts fell [¹](https://example.org/c). Homes [²](https://example.org/a).')); // links, not "[n]": Vane would turn that into a chip for its own sources
  assert.match(html, /## Sources\n\n1\. \[Wind versus tide\]\(https:\/\/example\.org\/c\)\n2\. \[Tidal energy in Orkney\]/);
  assert.match(html, /Draft\. Checking and editing next…/);
  assert.ok(html.indexOf('## Sources') < html.indexOf('<p role="status"'));
});

const RESULT = (over = {}) => ({
  ok: true, article: '# Tides\n\nCosts fell [1].\n\n## Sources\n\n1. [A](https://example.org/a)\n', language: 'en', mode: 'balanced', words: 412, sources: [{}],
  cost: 0.0123, ms: 47_000, degraded: [], checks: { ok: true, items: [{ name: 'length', level: 'ok', detail: '412 words' }] }, ...over,
});

test('the result is the article followed by one summary paragraph', () => {
  const html = renderArticleResult(RESULT());
  assert.ok(html.startsWith('# Tides'));
  assert.match(html, /412 words · 1 source · ≈ \$0\.012 · 47s · Balanced/);
  assert.equal((html.match(/<p role="status"/g) || []).length, 1);
  assert.match(renderArticleResult(RESULT({ language: 'el', sources: [{}, {}] })), /412 λέξεις · 2 πηγές/);
});

test('citations in the finished article become superscript links; the sources list is left as it is', () => {
  const html = renderArticleResult(RESULT({
    article: '# T\n\nA claim [1]. Two [1, 2]. A third [12].\n\n## Sources\n\n1. [A](https://example.org/a)\n2. [B](https://example.org/b)\n',
    sources: [{ url: 'https://example.org/a' }, { url: 'https://example.org/b' }],
  }));
  assert.match(html, /A claim \[¹\]\(https:\/\/example\.org\/a\)\./);
  assert.match(html, /Two \[¹\]\(https:\/\/example\.org\/a\) \[²\]\(https:\/\/example\.org\/b\)\./);
  assert.match(html, /A third ¹²\./); // no source 12: a plain superscript
  assert.match(html, /## Sources\n\n1\. \[A\]\(https:\/\/example\.org\/a\)\n2\. \[B\]/);
  assert.doesNotMatch(html, /\[\d+\]/);
});

test('degraded phases and weak checks are listed, escaped, at most six, without repeats', () => {
  const degraded = ['the critique failed: <b>x</b>', 'the critique failed: <b>x</b>', 'a', 'b', 'c', 'd', 'e'];
  const html = renderArticleResult(RESULT({ degraded, checks: { ok: false, items: [{ name: 'numbers', level: 'warn', detail: '1 sentence with numbers not in the cited source' }] } }));
  assert.match(html, /the critique failed: &lt;b&gt;x&lt;\/b&gt;/);
  assert.equal((html.match(/the critique failed/g) || []).length, 1);
  assert.equal((html.match(/<br>/g) || []).length, 6); // the summary plus at most six notes
  assert.doesNotMatch(renderArticleResult(RESULT({ degraded: ['x'], article: '# T <img src=x onerror=1>' })), /<img/);
});

test('failures explain credits, keys and other errors', () => {
  assert.match(renderArticleFailure({ status: 402, error: 'x' }), /no credits left/);
  assert.match(renderArticleFailure({ status: 401, error: 'x' }), /refused the API key/);
  assert.match(renderArticleFailure({ error: 'no sources found <b>' }), /no sources found &lt;b&gt;/);
  assert.match(renderArticleFailure({ error: 'x' }, 'el'), /Δεν μπόρεσα να γράψω το άρθρο/);
});

// ---- the chat hook ----

const model = (id, pin, pout) => ({ id, name: id, created: 1_790_000_000, context_length: 200000, architecture: { output_modalities: ['text'] }, pricing: { prompt: String(pin), completion: String(pout) }, supported_parameters: ['response_format'] });
const MODELS = [model('alpha/m1', 1e-6, 4e-6), model('beta/m2', 2e-6, 8e-6), model('gamma/m3', 3e-6, 12e-6)];
const TRIAL = Object.fromEntries(MODELS.map(m => [m.id, { en: { ok: true, tellsPerThousand: 0 }, el: { ok: true, tellsPerThousand: 0 }, json: { ok: true } }]));
const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { cost: 0.002 } });
const sentence = 'Tidal turbines in Orkney supplied about 1,200 homes last winter';
const draft = `# Tides at work\n\n## Case\n\n${Array.from({ length: 30 }, (_, i) => `${sentence} and the crews learned the work [${(i % 3) + 1}].`).join(' ')}`;

function fakeClient() {
  const calls = [];
  return {
    calls,
    models: async () => MODELS,
    chat: async (body) => {
      const sys = body.messages[0].content;
      const role = sys.includes('planning a researched article') ? 'outline' : sys.includes('senior journalist') ? 'draft' : sys.includes('web search queries') ? 'queries' : 'other';
      calls.push({ role, model: body.model });
      if (role === 'queries') return reply(JSON.stringify({ queries: ['tidal power', 'marine energy', 'ocean energy'] }));
      if (role === 'outline') return reply(JSON.stringify({ title: 'T', sections: [{ heading: 'h', points: [], sources: [1], words: 300 }] }));
      return reply(draft);
    },
  };
}

function ui() {
  const blocks = new Map(), events = [];
  return {
    events, blocks,
    emit: (x) => { blocks.set('b1', x); events.push(['emit', x]); return 'b1'; },
    update: (id, x) => { blocks.set(id, x); events.push(['update', x]); },
  };
}

test('the hook leaves other messages to Vane', async () => {
  const u = ui();
  assert.equal(await handleArticleRequest('what is the weather', { ...u, research: async () => SOURCES, client: fakeClient(), trial: TRIAL }), false);
  assert.deepEqual(u.events, []);
});

test('an article request in Speed mode: status, draft, then the finished article, with Vane\'s research and the mode\'s models', async () => {
  const u = ui(), client = fakeClient(), searched = [];
  let closed = 0;
  const handled = await handleArticleRequest('write an article about tidal power', {
    ...u, mode: 'speed', client, trial: TRIAL, researchDone: () => { closed++; },
    research: async (q) => { searched.push(q); return SOURCES; },
  });
  assert.equal(handled, true);
  assert.deepEqual(searched, ['tidal power']);
  assert.equal(closed, 1); // Vane's research display is closed once the sources are in
  assert.match(u.events[0][1], /Researching sources…/);
  assert.ok(u.events.some(([, x]) => x.startsWith('# Tides at work') && /Draft\. Checking and editing next/.test(x))); // the draft shows while checks would run
  const final = u.blocks.get('b1');
  assert.ok(final.startsWith('# Tides at work'));
  assert.match(final, /## Sources/);
  assert.match(final, /words · 3 sources · ≈ \$0\.00\d · \d+s · Speed/);
  assert.ok(final.endsWith(ANSWER_MARKER)); // the image/video search buttons stay hidden
  assert.deepEqual(client.calls.map(c => c.role), ['outline', 'draft']);
});

test('the Vane mode picks the price band; an unknown mode falls back to Balanced', async () => {
  const cheap = fakeClient(), dear = fakeClient();
  await handleArticleRequest('write an article about tidal power', { ...ui(), mode: 'speed', client: cheap, trial: TRIAL, research: async () => SOURCES });
  await handleArticleRequest('write an article about tidal power', { ...ui(), mode: 'quality', client: dear, trial: TRIAL, research: async () => SOURCES });
  assert.equal(cheap.calls.find(c => c.role === 'draft').model, 'alpha/m1');
  assert.equal(dear.calls.find(c => c.role === 'draft').model, 'gamma/m3');
  const odd = fakeClient();
  await handleArticleRequest('write an article about tidal power', { ...ui(), mode: 'turbo', client: odd, trial: TRIAL, research: async () => SOURCES });
  assert.ok(odd.calls.some(c => c.role === 'draft'));
});

test('a Greek request is researched in Greek and English and answered with Greek status words', async () => {
  const u = ui(), searched = [];
  await handleArticleRequest('γράψε ένα άρθρο για την παλιρροϊκή ενέργεια', { ...u, mode: 'speed', client: fakeClient(), trial: TRIAL, research: async (q) => { searched.push(q); return SOURCES; } });
  assert.deepEqual(searched.sort(), ['tidal power', 'την παλιρροϊκή ενέργεια']);
  assert.match(u.events[0][1], /Αναζήτηση πηγών…/);
});

test('research that finds nothing is tried twice, then reported as the reason', async () => {
  const u = ui();
  let n = 0;
  await handleArticleRequest('write an article about tidal power', { ...u, mode: 'speed', client: fakeClient(), trial: TRIAL, research: async () => { n++; return []; } });
  assert.equal(n, 2);
  assert.match(u.blocks.get('b1'), /The article could not be written\./);
  assert.match(u.blocks.get('b1'), /no sources found/);
});

test('no OpenRouter provider, or no model that passed the trial, is explained in the answer', async () => {
  const none = ui();
  assert.equal(await handleArticleRequest('write an article about tides', { ...none, research: async () => SOURCES, readConfig: async () => JSON.stringify({ modelProviders: [] }), trial: TRIAL }), true);
  assert.match(none.blocks.get('b1'), /needs an OpenRouter provider/);
  const noTrial = ui();
  await handleArticleRequest('write an article about tides', { ...noTrial, research: async () => SOURCES, client: fakeClient(), trial: {} });
  assert.match(noTrial.blocks.get('b1'), /No text model has passed the trial for English/);
});

test('a failing update or a crash inside the pipeline never throws into Vane', async () => {
  const u = ui();
  u.update = () => { throw new Error('block gone'); };
  assert.equal(await handleArticleRequest('write an article about tides', { ...u, mode: 'speed', client: fakeClient(), trial: TRIAL, research: async () => SOURCES, log: () => {} }), true);
  const v = ui();
  assert.equal(await handleArticleRequest('write an article about tides', { ...v, client: fakeClient(), trial: TRIAL, research: async () => SOURCES, pipeline: async () => { throw new Error('boom'); }, log: () => {} }), true);
  assert.match(v.blocks.get('b1'), /boom/);
});

// ---- the patch ----

const { TARGETS: ARTICLE } = require('../../patches/patch-article-chat.js');
const { TARGETS: IMAGE } = require('../../patches/patch-image-chat.js');
const CLASSIFY = IMAGE[0].from;
const ROUTE = `async function s(a,b){x;${CLASSIFY}{}).then(q=>q);m=null;y}`;

test('the article patch imports the hook from FANE_WRITE_DIR and hands over Vane\'s research', () => {
  assert.equal(ARTICLE.length, 2); // the hook, and the upgrade for a hook installed before follow-up edits
  const [t] = ARTICLE;
  assert.equal(t.file, FILES.chatRoute);
  assert.ok(t.to.includes(`file://${FANE_WRITE_DIR}/vane-hook.mjs`));
  assert.ok(t.to.includes(JSON.stringify(CONFIG_JSON)));
  for (const need of ['handleArticleRequest(b.followUp', 'mode:b.config.mode', 'new f.A().research(a,', 'C.classification.skipSearch=!1', 'researchDone:()=>a.emit("data",{type:"researchComplete"})', 'a.emit("end",{})']) assert.ok(t.to.includes(need), need);
  assert.ok(t.to.endsWith(CLASSIFY) && t.to.includes(t.marker)); // Vane's own step follows the hook
});

test('the article and image patches apply in either order, and again, to the same two hooks', () => {
  const all = [IMAGE[0], ARTICLE[0]];
  const apply = (order) => {
    let files = { [FILES.chatRoute]: ROUTE };
    for (const t of order) { const r = planPatch(files, [t]); assert.deepEqual(r.errors, [], t.name); files = r.next; }
    const again = planPatch(files, order);
    assert.deepEqual([again.errors, again.applied], [[], []]); // a second pass changes nothing
    return files[FILES.chatRoute];
  };
  for (const text of [apply(all), apply([...all].reverse())]) {
    assert.equal((text.match(/handleArticleRequest/g) || []).length, 1);
    assert.equal((text.match(/handleImageRequest/g) || []).length, 1);
    assert.ok(text.indexOf('fane:article-chat') < text.indexOf(CLASSIFY) && text.indexOf('fane:image-chat') < text.indexOf(CLASSIFY));
  }
});

// ---- follow-up edits ----

test('edit requests are recognised in English and Greek; questions and new topics are not', () => {
  for (const q of ['make it shorter', 'Please shorten the introduction', 'rewrite the conclusion', 'now translate it to English', 'add a paragraph about costs', 'more formal please', 'κάνε το πιο σύντομο', 'Ξαναγράψε την εισαγωγή', 'μετάφρασέ το στα αγγλικά', 'πιο απλά, παρακαλώ']) assert.equal(isArticleEdit(q), true, q);
  for (const q of ['what is tidal power', 'why did you cite source 2', 'explain the second section', 'ποια είναι η πηγή 3', 'tell me more']) assert.equal(isArticleEdit(q), false, q);
});

test('the language of an edit follows a translation request only when the language ends the sentence', () => {
  assert.equal(targetLanguage('translate it to English', 'el'), 'en');
  assert.equal(targetLanguage('μετάφρασέ το στα αγγλικά', 'el'), 'en');
  assert.equal(targetLanguage('translate this into Greek, please', 'en'), 'el');
  assert.equal(targetLanguage('add a line to Greek readers about costs', 'en'), 'en');
  assert.equal(targetLanguage('make it shorter', 'el'), 'el');
});

const previous = () => tagged(renderArticleResult(RESULT({ article: draft + sourcesSection(SOURCES, 'en'), sources: SOURCES, words: 450 })));

test('an earlier answer is read back as the article, with [n] citations and its sources', () => {
  const p = parseArticleAnswer(previous());
  assert.ok(p.body.startsWith('# Tides at work'));
  assert.match(p.body, /work \[1\]\./);
  assert.match(p.body, /work \[3\]\./);
  assert.doesNotMatch(p.body, /[¹²³]|<p|Sources/);
  assert.deepEqual(p.sources.map(s => [s.title, s.url]), SOURCES.map(s => [s.title, s.url]));
  assert.equal(p.lang, 'en');
  assert.equal(parseArticleAnswer('Just a short answer from Vane.'), null);
  assert.equal(parseArticleAnswer(''), null);
});

test('adjacent citation links come back as one group', () => {
  const a = tagged(renderArticleResult(RESULT({ article: draft.replace('work [1].', 'work [1, 3].') + sourcesSection(SOURCES, 'en'), sources: SOURCES })));
  assert.match(parseArticleAnswer(a).body, /work \[1, 3\]\./);
});

const shorter = draft.split('. ').slice(0, 12).join('. ') + '.';
function editClient(answer = shorter) {
  const calls = [];
  return { calls, models: async () => MODELS, chat: async (body) => { calls.push(body.messages[1].content); return reply(answer); } };
}

test('"make it shorter" after an article edits it in one call, without a new search', async () => {
  const u = ui(), client = editClient();
  let searched = 0;
  const handled = await handleArticleRequest('make it shorter', { ...u, mode: 'speed', client, trial: TRIAL, lastAnswer: async () => previous(), research: async () => { searched++; return SOURCES; } });
  assert.equal(handled, true);
  assert.equal(searched, 0);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0], /Request from the author \(do exactly this and nothing else\): make it shorter/);
  assert.match(u.events[0][1], /Editing the article…/);
  const final = u.blocks.get('b1');
  assert.ok(final.startsWith('# Tides at work'));
  assert.match(final, /## Sources/);
  assert.match(final, /words · 3 sources · ≈ \$0\.00\d( · \d+s)? · Speed/); // the fake clock is instant
  assert.ok(final.endsWith(ANSWER_MARKER));
});

test('an edit that loses the title or most of the text is refused and says so', async () => {
  for (const bad of ['Short answer without a title.', '# Tides\n\nVery short.']) {
    const u = ui();
    await handleArticleRequest('make it shorter', { ...u, mode: 'speed', client: editClient(bad), trial: TRIAL, lastAnswer: async () => previous(), research: async () => SOURCES });
    assert.match(u.blocks.get('b1'), /The article could not be changed\./);
    assert.match(u.blocks.get('b1'), /not changed/);
  }
});

test('an edit keeps Vane in charge when the previous answer is not an article, or the message is an image request', async () => {
  const client = editClient();
  const u = ui();
  assert.equal(await handleArticleRequest('make it shorter', { ...u, client, trial: TRIAL, lastAnswer: async () => 'Tidal power is a form of hydropower.', research: async () => SOURCES }), false);
  assert.equal(await handleArticleRequest('make an image of a tidal turbine', { ...u, client, trial: TRIAL, lastAnswer: async () => previous(), research: async () => SOURCES }), false);
  assert.equal(await handleArticleRequest('make it shorter', { ...u, client, trial: TRIAL, research: async () => SOURCES }), false); // no previous answer at all
  assert.deepEqual([u.events, client.calls], [[], []]);
});

test('a citation the edit invents is removed and noted', async () => {
  const u = ui();
  await handleArticleRequest('make it shorter', { ...u, mode: 'speed', client: editClient(shorter.replace('work [1].', 'work [9].')), trial: TRIAL, lastAnswer: async () => previous(), research: async () => SOURCES });
  assert.match(u.blocks.get('b1'), /removed citations to sources that do not exist: \[9\]/);
  assert.doesNotMatch(u.blocks.get('b1'), /⁹/);
});

test('the patch can upgrade a hook installed before follow-up edits', () => {
  const old = 'async function s(a,b){return H.handleArticleRequest(b.followUp,{mode:b.config.mode,configPath:"/c"})}';
  const r = planPatch({ [FILES.chatRoute]: old }, [ARTICLE[1]]);
  assert.deepEqual(r.errors, []);
  assert.match(r.next[FILES.chatRoute], /handleArticleRequest\(b\.followUp,\{lastAnswer:async\(\)=>\{.*,history:b\.chatHistory,mode:b\.config\.mode,configPath:"\/c"\}\)/);
  assert.deepEqual(planPatch(r.next, [ARTICLE[1]]).applied, []); // and a second pass changes nothing
});
