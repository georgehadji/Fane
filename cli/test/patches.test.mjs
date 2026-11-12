// The shared patch engine (patches/lib/apply-targets.js) and the patch definitions it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { planPatch, isApplied } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');

const F = '/x/bundle.js';
const T = (o) => ({ name: 't', file: F, ...o });

test('applies a target once; re-running is a no-op', () => {
  const t = T({ from: 'a=1', to: 'a=2' });
  const one = planPatch({ [F]: 'var a=1;' }, [t]);
  assert.deepEqual([one.errors, one.applied, one.next[F]], [[], ['t'], 'var a=2;']);
  const two = planPatch(one.next, [t]);
  assert.deepEqual([two.errors, two.applied, two.next[F]], [[], [], 'var a=2;']);
});

test('a marker proves a target applied after a later patch edited its output', () => {
  const t = T({ from: 'a=1', to: 'a=2/*m*/', marker: '/*m*/' });
  assert.ok(isApplied('var a=3/*m*/;', t));
  assert.deepEqual(planPatch({ [F]: 'var a=3/*m*/;' }, [t]).errors, []);
});

test('a CRLF checkout writes the same text as an LF one, so its run does not apply a target twice', () => {
  const crlf = T({ from: 'a=1', to: 'a=function(){\r\nreturn 2\r\n}()' });
  const lf = T({ from: 'a=1', to: 'a=function(){\nreturn 2\n}()' });
  const one = planPatch({ [F]: 'var a=1;' }, [crlf]);
  assert.equal(one.next[F], 'var a=function(){\nreturn 2\n}();');
  assert.deepEqual(planPatch(one.next, [lf]).applied, []);
  assert.deepEqual(planPatch(planPatch({ [F]: 'var a=1;' }, [lf]).next, [crlf]).applied, []);
});

test('alternatives: the first from that matches exactly once is used', () => {
  const t = T({ alts: [{ from: 'x()', to: 'X()' }, { from: 'y()', to: 'Y()' }] });
  assert.equal(planPatch({ [F]: 'y();' }, [t]).next[F], 'Y();');
});

test('all or nothing: one bad target means no changes at all', () => {
  const r = planPatch({ [F]: 'var a=1;' }, [T({ name: 'ok', from: 'a=1', to: 'a=2' }), T({ name: 'bad', from: 'nope', to: 'x' })]);
  assert.deepEqual(r.errors, ['bad: expected 1 match, found 0']);
  assert.equal(r.next[F], 'var a=2;'); // planned only; run() writes nothing when errors exist
  assert.ok(planPatch({ [F]: 'a=1;a=1;' }, [T({ from: 'a=1', to: 'a=2' })]).errors[0].includes('found 2'));
});

test('optional targets are skipped, not failed, when absent', () => {
  const r = planPatch({ [F]: 'var a=1;' }, [T({ from: 'zzz', to: 'q', optional: 'needs other patch' })]);
  assert.deepEqual([r.errors, r.skipped], [[], ['t (needs other patch)']]);
});

test('a patched bundle that does not parse is refused', () => {
  const r = planPatch({ [F]: 'var a=1;' }, [T({ from: 'a=1', to: 'a=(' })]);
  assert.match(r.errors[0], /does not parse/);
});

test('a stylesheet is patched without the JavaScript parse check', () => {
  const css = '/x/app.css';
  const r = planPatch({ [css]: '.a{color:red}' }, [{ name: 'c', file: css, from: '.a{color:red}', to: '.a{color:red}\n.b{color:#000}' }]);
  assert.deepEqual([r.errors, r.applied], [[], ['c']]);
});

test('patch-colors: balanced rules after the last one of the stylesheet, every color a 6-digit hex', () => {
  const { TARGETS, COLORS } = require('../../patches/patch-colors.js');
  const end = '.xl\\:text-8xl{font-size:6rem;line-height:1}}';
  const one = planPatch({ [FILES.appCss]: `x{}${end}` }, TARGETS);
  assert.deepEqual(one.errors, []);
  assert.ok(one.next[FILES.appCss].endsWith(`${end}\n${COLORS}\n`));
  assert.deepEqual(planPatch(one.next, TARGETS).applied, []); // idempotent
  assert.equal(COLORS.split('{').length, COLORS.split('}').length);
  assert.ok(COLORS.match(/#[0-9a-f]+\b/gi).every(c => c.length === 7));
});

test('patch-colors: the first version is replaced where it stands, and no GitHub grey or sky blue is left in the block', () => {
  const { TARGETS, COLORS, COLORS_V1 } = require('../../patches/patch-colors.js');
  const end = '.xl\\:text-8xl{font-size:6rem;line-height:1}}';
  const r = planPatch({ [FILES.appCss]: `x{}${end}\n/*other*/\n\n${COLORS_V1}\n` }, TARGETS);
  assert.deepEqual(r.errors, []);
  assert.equal(r.next[FILES.appCss], `x{}${end}\n/*other*/\n\n${COLORS}\n`);
  assert.doesNotMatch(COLORS, /rgb\((13 17 23|22 27 34|33 38 45|246 248 250|232 237 241)\b|#(e6edf3|8b949e|58a6ff|2563eb|0369a1)/i);
  assert.match(COLORS, /\.bg-light-primary\{background-color:rgb\(247 242 234\//);
});

test('patch-colors: version 2 is upgraded in place, and a filled button (Send) is excluded from the icon hover color', () => {
  const { TARGETS, COLORS, COLORS_V2, COLORS_V3 } = require('../../patches/patch-colors.js');
  const end = '.xl\\:text-8xl{font-size:6rem;line-height:1}}';
  for (const old of [COLORS_V2, COLORS_V3]) {
    const r = planPatch({ [FILES.appCss]: `x{}${end}\n/*other*/\n\n${old}\n/*after*/` }, TARGETS);
    assert.deepEqual(r.errors, []);
    assert.equal(r.next[FILES.appCss], `x{}${end}\n/*other*/\n\n${COLORS}\n/*after*/`);
    assert.deepEqual(planPatch(r.next, TARGETS).applied, []);
  }
  assert.ok(COLORS.startsWith('/*fane:colors-4*/') && !COLORS.includes('colors-3') && !COLORS.includes('colors-2'));
  // the browser's white canvas never shows: <html> is paper on light and charcoal on dark
  assert.ok(COLORS.includes('html{background-color:#f7f2ea}\nhtml.dark{background-color:#110f0b}\n'));
  // the white fade behind a chat's follow-up bar (light theme) is drawn in the page color, with the same nine stops
  const fade = COLORS.slice(COLORS.indexOf('html:not(.dark) .pointer-events-none.absolute.-bottom-6'));
  assert.equal(fade.split('rgb(247 242 234/').length - 1, 7);
  assert.match(fade, /^[^}]*linear-gradient\(to top,#f7f2ea 0%,#f7f2ea 35%,[^}]*rgb\(247 242 234\/0\) 100%\)!important\}$/);
  assert.doesNotMatch(fade, /255/);
  // the same rules, plus the exclusion of the filled sky/terracotta button, in light and dark
  const filled = String.raw`:not(.bg-\[\#24A0ED\]):not(.bg-sky-500)`;
  assert.ok(COLORS.includes(`html button[data-fane-icon]${filled}:hover,html a[data-fane-icon]${filled}:hover{color:#9e4420}`));
  assert.ok(COLORS.includes(`html.dark button[data-fane-icon]${filled}:hover,html.dark a[data-fane-icon]${filled}:hover{color:#e0805a}`));
  assert.ok(!COLORS.includes('html button[data-fane-icon]:hover'));
  assert.equal(COLORS.split('{').length, COLORS.split('}').length);
});

test('patch-icon-buttons: an icon-only button gets the name of its Lucide icon, a named or texted one is left alone', () => {
  const { LABEL_ICONS } = require('../../patches/patch-icon-buttons.js');
  const el = (cls, { text = '', label = null } = {}) => {
    const attrs = new Map(label ? [['aria-label', label]] : []);
    return {
      textContent: text, title: '',
      querySelector: () => (cls ? { getAttribute: () => cls } : null),
      hasAttribute: (k) => attrs.has(k), getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v),
    };
  };
  const bin = el('lucide lucide-trash'), speak = el('lucide lucide-volume2 lucide-volume-2'), odd = el('lucide lucide-banana');
  const named = el('lucide lucide-share', { label: 'Share chat' }), texted = el('lucide lucide-copy', { text: 'Copy' });
  const all = [bin, speak, odd, named, texted];
  globalThis.window = {};
  globalThis.document = { documentElement: {}, querySelectorAll: () => all };
  globalThis.MutationObserver = class { observe() {} };
  try { LABEL_ICONS(); } finally { delete globalThis.window; delete globalThis.document; delete globalThis.MutationObserver; }
  assert.deepEqual([bin, speak, odd, named, texted].map(b => [b.getAttribute('aria-label'), b.title, b.hasAttribute('data-fane-icon')]),
    [['Delete', 'Delete', true], ['Read aloud', 'Read aloud', true], [null, '', true], ['Share chat', '', true], [null, '', false]]);
});

test('patch-type: intact Commissioner WOFF2s for Latin and Greek on Vane\'s font class, and it stacks with patch-colors in either order', () => {
  const colors = require('../../patches/patch-colors.js');
  const type = require('../../patches/patch-type.js');
  const fonts = [...type.TYPE.matchAll(/base64,([A-Za-z0-9+/=]+)\)/g)].map(m => Buffer.from(m[1], 'base64'));
  assert.equal(fonts.length, 12); // Commissioner: 3 subsets; Literata: 3 subsets, roman and italic; Syne: 3 subsets
  // Discover and Library page titles: Syne, which has Latin and Greek; PP Editorial for what it lacks
  assert.ok(type.TYPE.includes('h1.text-5xl{font-family:Syne,"PP Editorial",serif!important;font-weight:400;'));
  assert.equal(type.TYPE.split('font-family:Syne;').length - 1, 3);
  assert.ok(type.TYPE.includes('.prose{font-family:Literata,Commissioner,'));
  assert.ok(type.TYPE.includes('.prose [role=status]{font-family:Commissioner,')); // Fane's receipts stay sans
  for (const font of fonts) {
    assert.equal(font.toString('latin1', 0, 4), 'wOF2');
    assert.equal(font.readUInt32BE(8), font.length); // the WOFF2 header's own length matches
  }
  assert.match(type.TYPE, /unicode-range:U\+0000-00FF,/); // Latin
  assert.match(type.TYPE, /unicode-range:U\+0370-0377,[^}]*U\+03A3-03FF\}/); // Greek
  assert.match(type.TYPE, /\.__className_62a70d\{font-family:Commissioner,Montserrat,/); // Montserrat stays for Cyrillic
  assert.equal(type.TYPE.split('{').length, type.TYPE.split('}').length);
  const end = '.xl\\:text-8xl{font-size:6rem;line-height:1}}';
  for (const order of [[colors, type], [type, colors]]) {
    let css = { [FILES.appCss]: `x{}${end}` };
    for (const p of order) { const r = planPatch(css, p.TARGETS); assert.deepEqual(r.errors, []); css = r.next; }
    assert.ok(css[FILES.appCss].includes(colors.COLORS) && css[FILES.appCss].includes(type.TYPE));
    for (const p of order) assert.deepEqual(planPatch(css, p.TARGETS).applied, []); // both still count as applied
  }
});

test('patch-type: a stylesheet patched with an earlier version is upgraded in place, wherever patch-colors put it', () => {
  const colors = require('../../patches/patch-colors.js');
  const type = require('../../patches/patch-type.js');
  const end = '.xl\\:text-8xl{font-size:6rem;line-height:1}}';
  for (const old of [type.TYPE_V1, type.TYPE_V2, type.TYPE_V3, type.TYPE_V4].flatMap(v => [`x{}${end}\n${v}\n\n${colors.COLORS}\n`, `x{}${end}\n${colors.COLORS}\n\n${v}\n`])) {
    const r = planPatch({ [FILES.appCss]: old }, type.TARGETS);
    assert.deepEqual(r.errors, []);
    const css = r.next[FILES.appCss];
    assert.ok(css.includes(type.TYPE) && css.includes(colors.COLORS));
    assert.ok(!css.includes('/*fane:type*/') && !css.includes('/*fane:type-2*/') && !css.includes('/*fane:type-3*/')); // the old block is gone, not left above the new one
    assert.deepEqual(planPatch(r.next, type.TARGETS).applied, []);
  }
});

test('patch-discover-ellipsis: three periods at the end of a summary become a no-break space and an ellipsis', () => {
  const { ELLIPSIS, TARGETS } = require('../../patches/patch-discover-ellipsis.js');
  const out = ELLIPSIS([{ content: 'but that...' }, { content: 'ends here …' }, { content: 'v1.2... works' }, { title: 't' }, null]);
  assert.deepEqual(out.map(b => b?.content), ['but that …', 'ends here …', 'v1.2... works', undefined, undefined]);
  assert.equal(ELLIPSIS('x'), 'x');
  // the injected code is valid JavaScript in the route
  const route = 'async function GET(){let e=[];return Response.json({blogs:e},{status:200})}';
  const r = planPatch({ [FILES.discoverRoute]: route }, TARGETS);
  assert.deepEqual(r.errors, []);
});

test('apply.mjs restarts Vane only for a patch with a server target; browser chunks and the stylesheet need a reload', () => {
  const { BROWSER_DIR, needsRestart } = require('../../patches/lib/vane.js');
  const browser = Object.entries(FILES).filter(([, f]) => f.startsWith(BROWSER_DIR)).map(([k]) => k).sort();
  assert.deepEqual(browser, ['appCss', 'chatClient', 'discoverClient', 'layoutClient', 'libraryClient', 'messageClient']);
  assert.equal(needsRestart([{ file: FILES.layoutClient }, { file: FILES.appCss }]), false);
  assert.equal(needsRestart([{ file: FILES.layoutClient }, { file: FILES.chatRoute }]), true); // one server target is enough
  const patch = (n) => require(`../../patches/${n}.js`).TARGETS;
  assert.equal(needsRestart(patch('patch-theme-toggle')), false);
  assert.equal(needsRestart(patch('patch-colors')), false);
  assert.equal(needsRestart(patch('patch-sources-required')), true);
  assert.equal(needsRestart(patch('patch-discover-summary-greek')), true); // also edits the server-rendered pages
});

test('the README, and the project page\'s count and apply output, name every patch in patches/', () => {
  const names = readdirSync(new URL('../../patches/', import.meta.url)).filter(f => /^patch-.*\.js$/.test(f)).map(f => f.slice(0, -3)).sort();
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  for (const n of names) assert.ok(readme.includes(`patches/${n}.js`), `README.md does not mention patches/${n}.js`);
  const page = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
  assert.deepEqual(page.match(/^ok {4}patch-[a-z-]+(?= applied)/gm).map(l => l.slice(6)), names);
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
  const words = tens[Math.floor(names.length / 10)] + (names.length % 10 ? `-${ones[names.length % 10]}` : '');
  assert.ok(page.includes(`${words} patches`), `docs/index.html should say "${words} patches"`);
  assert.ok(page.includes(`${words[0].toUpperCase()}${words.slice(1)} patches fix`), 'the page sentence');
});

test('patch-sources-required: with no search result and no widget, the first question gets "nothing was found" and a follow-up a rule', async () => {
  const quality = require('../../patches/patch-quality-check.js');
  const required = require('../../patches/patch-sources-required.js');
  // the chat route's writer call as Vane writes it; `calls` records what reached the model
  const route = `(async (b,o,n,s,calls)=>{let t=b.config.llm.streamText({messages:[{role:"system",content:s},...b.chatHistory,{role:"user",content:b.followUp}]}),u="";let out="";for await(let c of t)out+=c.contentChunk;return out})`;
  let r = planPatch({ [FILES.chatRoute]: route }, quality.TARGETS.slice(0, 1));
  r = planPatch(r.next, required.TARGETS.slice(0, 1));
  assert.deepEqual([r.errors, r.applied], [[], ['no answer from memory (/api/chat)']]);
  for (const t of [quality.TARGETS[0], required.TARGETS[0]]) assert.deepEqual(planPatch(r.next, [t]).applied, [], t.name); // file order, twice
  const answer = eval(r.next[FILES.chatRoute]);
  const ask = async (followUp, { findings = [], widgets = [], history = [] } = {}) => {
    const calls = [];
    const llm = { streamText: ({ messages }) => { calls.push(messages[0].content); return (async function* () { yield { contentChunk: 'from the model' }; })(); } };
    const text = await answer({ config: { mode: 'speed', llm }, chatHistory: history, followUp }, { searchFindings: findings }, widgets, 'PROMPT', calls);
    return { text, calls };
  };
  assert.deepEqual(await ask('news?', { findings: [{}] }), { text: 'from the model', calls: ['PROMPT'] });
  assert.deepEqual(await ask('weather in Athens', { widgets: [{}] }), { text: 'from the model', calls: ['PROMPT'] });
  assert.deepEqual(await ask('latest news in Greece?'), { text: required.NOTHING.en, calls: [] });
  assert.deepEqual(await ask('τα τελευταία νέα στην Ελλάδα;'), { text: required.NOTHING.el, calls: [] });
  assert.deepEqual(await ask('translate that', { history: [['human', 'q'], ['assistant', 'a']] }), { text: 'from the model', calls: [`PROMPT${required.FOLLOW_UP_RULE}`] });
  // the search route (CLI) matches too, after patch-quality-check
  const search = `async function x(a,b,k,l,p){for await(let c of b.config.llm.streamText({messages:[{role:"system",content:p},...b.chatHistory,{role:"user",content:b.followUp}]}))a.emit("data",{type:"response",data:c.contentChunk});a.emit("end",{})}`;
  let s = planPatch({ [FILES.searchRoute]: search }, quality.TARGETS.slice(1));
  s = planPatch(s.next, required.TARGETS.slice(1));
  assert.deepEqual([s.errors, s.applied], [[], ['no answer from memory (/api/search)']]);
});

test('patch-answer-language: the writer prompt asks for the language of the question, first among its formatting rules', () => {
  const { TARGETS } = require('../../patches/patch-answer-language.js');
  const prompt = 'const w=(a,b)=>`\n\n    ### Formatting Instructions\n    - **Structure**: Use headings.\n    ${a}`;';
  const r = planPatch({ [FILES.research]: prompt }, TARGETS);
  assert.deepEqual(r.errors, []);
  const text = new Function(`${r.next[FILES.research]}; return w('ctx')`)();
  assert.match(text, /### Formatting Instructions\n {4}- \*\*Language\*\*: Write the whole answer[^\n]*Greek\.\n {4}- \*\*Structure\*\*/);
  assert.deepEqual(planPatch(r.next, TARGETS).applied, []);
});
test('patch-discover-summary-greek: every Discover and home news link asks for a Greek summary, in an ASCII bundle', () => {
  const { TARGETS, ASK } = require('../../patches/patch-discover-summary-greek.js');
  // one fake bundle per file, holding each of its links as Vane writes them
  const files = {};
  for (const t of TARGETS) {
    const v = /\$\{(\w)\.url\}/.exec(t.from)[1];
    files[t.file] = `${files[t.file] || ''}links.push((${v})=>({href:\`/?${t.from} x"}));`;
  }
  const r = planPatch(files, TARGETS);
  assert.deepEqual([r.errors, r.applied.length], [[], 6]);
  assert.deepEqual(planPatch(r.next, TARGETS).applied, []);
  for (const [file, text] of Object.entries(r.next)) {
    assert.ok(/^[\x20-\x7e]*$/.test(text), file);
    const links = [];
    new Function('links', text)(links);
    for (const make of links) assert.equal(make({ url: 'https://x.test/a' }).href, `/?q=${ASK}https://x.test/a`, file);
  }
});

test('patch-discover-greek: the Discover search adds every Greek site and query of the topic, in Greek; a failing one adds nothing', async () => {
  const { GREEK, TARGETS } = require('../../patches/patch-discover-greek.js');
  assert.deepEqual(Object.keys(GREEK), ['tech', 'finance', 'art', 'sports', 'entertainment']); // Vane's Discover topics
  // the patched search, run with a fake SearXNG client
  const route = `(async (b, d, v) => { let e; ${TARGETS[0].alts[0].from}; return e; })`;
  const r = planPatch({ [FILES.discoverRoute]: route }, TARGETS);
  assert.deepEqual(r.errors, []);
  const calls = [];
  const v = { n: async (q, { language }) => { calls.push([q, language]); if (q.includes('lifo.gr')) throw new Error('bing down'); return { results: [{ url: `${language}:${q}` }] }; } };
  const english = { links: ['wired.com'], query: ['AI'] };
  const run = async (topic) => (await eval(r.next[FILES.discoverRoute])(new URLSearchParams(topic ? { topic } : {}), english, v)).map(s => s.url);
  const art = await run('art');
  assert.equal(art.length, 1 + GREEK.art.links.length * 2 - 2); // lifo.gr's two searches failed and gave nothing
  assert.ok(art.includes('el:site:efsyn.gr πολιτισμός') && art.includes('en:site:wired.com AI'));
  assert.ok(calls.filter(([, l]) => l === 'el').every(([q]) => /^site:\S+\.(gr|com) /.test(q)));
  assert.equal((await run()).filter(u => u.startsWith('el:')).length, GREEK.tech.links.length * 2); // no topic: tech, as in Vane
});

test('patch-editorial-greek: a static Greek-only face under PP Editorial\'s name, stacked with patch-colors and patch-type', () => {
  const ed = require('../../patches/patch-editorial-greek.js');
  const colors = require('../../patches/patch-colors.js');
  const type = require('../../patches/patch-type.js');
  const font = Buffer.from(ed.EDITORIAL_GREEK.match(/base64,([A-Za-z0-9+/=]+)\)/)[1], 'base64');
  assert.equal(font.toString('latin1', 0, 4), 'wOF2');
  assert.equal(font.readUInt32BE(8), font.length);
  assert.ok(!font.includes('fvar')); // static: a stretch descriptor would keep the face from ever matching
  assert.match(ed.EDITORIAL_GREEK, /font-family:PP Editorial;font-style:normal;font-weight:300;font-display/);
  assert.match(ed.EDITORIAL_GREEK, /unicode-range:U\+0370-0377,[^}]*U\+03A3-03FF\}$/);
  const end = '.xl\\:text-8xl{font-size:6rem;line-height:1}}';
  let css = { [FILES.appCss]: `x{}${end}` };
  for (const p of [colors, ed, type]) { const r = planPatch(css, p.TARGETS); assert.deepEqual(r.errors, []); css = r.next; }
  for (const p of [colors, ed, type]) assert.deepEqual(planPatch(css, p.TARGETS).applied, []);
});

test('patch-greek-lang: mostly Greek text is marked "el", anything else keeps the page language', () => {
  const { LANG } = require('../../patches/patch-greek-lang.js');
  assert.equal(LANG('γράψε ένα άρθρο για το iPhone 17'), 'el');
  assert.equal(LANG('ἀρχή'), 'el'); // polytonic
  assert.equal(LANG('write about the Ελλάδα islands'), undefined);
  assert.equal(LANG('2024'), undefined);
  assert.equal(LANG(undefined), undefined);
});

test('patch-quality-mode: research stops after the rounds without a new page the table names (Balanced 2, Quality 2, Speed never)', () => {
  const { TARGETS, STOP_V1, STOP_V2 } = require('../../patches/patch-quality-mode.js');
  const loop = TARGETS.filter(t => /pages seen|without a new page/.test(t.name));
  // Vane's research loop, cut down to the lines the two targets edit.
  const fake = 'var research=(rounds,b,console)=>{let used=0,c=[],d=rounds.length,f={b:()=>""},i=0;for(let g=0;g<d;g++){let l=(0,f.b)(i,b.config.mode,g,d,b.config.fileIds);used++;let r=rounds[g];c.push(...r)}let l=c.filter(a=>"search_results"===a.type).flatMap(a=>a.results),m=new Map,n=l.map(a=>a);return used};';
  const out = planPatch({ [loop[0].file]: fake }, loop);
  assert.deepEqual([out.errors, out.applied.length, planPatch(out.next, loop).applied], [[], 2, []]);
  const research = new Function(out.next[loop[0].file] + 'return research')();
  const quiet = { log() {} };
  const found = (...urls) => [{ type: 'search_results', results: urls.map(url => ({ metadata: { url } })) }];
  const run = (mode, rounds) => research(rounds, { config: { mode } }, quiet);
  assert.equal(run('quality', [found('a'), found('b'), found('c'), found('d')]), 4);
  assert.equal(run('quality', [found('a', 'b'), found('a'), found('b'), found('c')]), 3);
  assert.equal(run('quality', [found('a'), found('a'), found('b'), found('b'), found('b')]), 5); // a new page resets the count
  assert.equal(run('quality', [[], [], found('a'), found('b')]), 4); // rounds before the first search do not count
  assert.equal(run('balanced', [found('a'), found('b'), found('c'), found('d')]), 4);
  assert.equal(run('balanced', [found('a'), found('a'), found('a'), found('a')]), 3);
  assert.equal(run('balanced', [found('a'), found('a'), found('b'), found('b'), found('b')]), 5); // a new page resets the count
  assert.equal(run('speed', [found('a'), found('a'), found('a'), found('a')]), 4);
  // A container patched with an earlier stop (Quality only, or Balanced after one round) is upgraded in place: one stop afterwards, not two.
  const stopTarget = loop[1];
  const seen = planPatch({ [loop[0].file]: fake }, [loop[0]]).next;
  for (const before of [STOP_V1, STOP_V2]) {
    const old = { [loop[0].file]: seen[loop[0].file].replace(stopTarget.alts[2].from, before + stopTarget.alts[2].from) };
    const up = planPatch(old, [stopTarget]);
    assert.deepEqual([up.errors, up.applied.length], [[], 1]);
    assert.equal(up.next[loop[0].file].split('/*fane:stop-3*/').length, 2);
    assert.ok(!up.next[loop[0].file].includes('two rounds found no new page') && !up.next[loop[0].file].includes('/*fane:stop-2*/'));
    assert.deepEqual(planPatch(up.next, [stopTarget]).applied, []);
  }
});

test('patch-quality-mode: Balanced and Quality researchers see trimmed results, longer for a page the reader added facts to', () => {
  const { TARGETS, COMPACT_V1 } = require('../../patches/patch-quality-mode.js');
  const { RESEARCHER_CHARS } = require('../../patches/lib/vane.js');
  const t = TARGETS.find(x => x.name === 'compact researcher context');
  const fake = 'var f=(r,q,b)=>{let k=[];' + t.alts[1].from + ';return k};';
  const results = [{ metadata: { title: 'T', url: 'u1' }, content: 'x'.repeat(4000) }, { metadata: { title: 'R', url: 'u2' }, content: 'y'.repeat(4000), fane_read: true }];
  const input = [{ type: 'search_results', results }, { type: 'done' }];
  const out = planPatch({ [t.file]: fake }, [t]);
  assert.deepEqual([out.errors, out.applied.length, planPatch(out.next, [t]).applied], [[], 1, []]);
  const f = new Function(out.next[t.file] + 'return f')();
  const seen = (mode) => f(input, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], { config: { mode } }).map(m => JSON.parse(m.content));
  assert.deepEqual(seen('balanced')[0].results.map(x => x.content.length), [RESEARCHER_CHARS.snippet, RESEARCHER_CHARS.read]);
  assert.deepEqual(seen('quality')[0].results.map(x => x.content.length), [RESEARCHER_CHARS.snippet, RESEARCHER_CHARS.read]);
  assert.deepEqual(seen('speed')[0].results.map(x => x.content.length), [4000, 4000]);
  assert.deepEqual(seen('balanced')[1], { type: 'done' }); // only search results are cut
  // The Quality-only version (1500 for every result) is upgraded in place.
  const old = planPatch({ [t.file]: fake.replace(t.alts[1].from, COMPACT_V1) }, [t]);
  assert.deepEqual([old.errors, old.applied.length, old.next[t.file]], [[], 1, out.next[t.file]]);
});

test('patch-mode-icons: each mode says what it does, with a full stop, in the browser chunk and the server chunk alike', () => {
  const { TARGETS, MODE_COPY } = require('../../patches/patch-mode-icons.js');
  const copy = TARGETS.filter(t => / description [(]/.test(t.name));
  assert.deepEqual(copy.map(t => t.file), [...MODE_COPY.map(() => FILES.messageClient), ...MODE_COPY.map(() => FILES.homeNews)]);
  for (const [, , from, to] of MODE_COPY) assert.ok(to.endsWith('.') && !/[0-9]/.test(to) && !to.includes(from), to); // no seconds: they depend on the model
  const menu = '[' + MODE_COPY.map(([key, title, from]) => `{key:"${key}",title:"${title}",description:"${from}",icon:1}`).join(',') + ']';
  const files = { [FILES.messageClient]: menu, [FILES.homeNews]: `x;${menu};y` };
  const out = planPatch(files, copy);
  assert.deepEqual([out.errors, out.applied.length], [[], 6]);
  for (const file of [FILES.messageClient, FILES.homeNews]) for (const [, , from, to] of MODE_COPY) assert.ok(out.next[file].includes(`description:"${to}"`) && !out.next[file].includes(from), file);
  assert.deepEqual(planPatch(out.next, copy).applied, []);
});

test('every patch declares well-formed targets on known Vane files', () => {
  const dir = new URL('../../patches/', import.meta.url);
  const known = new Set(Object.values(FILES));
  const names = new Set();
  for (const f of readdirSync(dir).filter(x => /^patch-.*\.js$/.test(x))) {
    const { TARGETS } = require(`../../patches/${f}`);
    assert.ok(Array.isArray(TARGETS) && TARGETS.length, f);
    for (const t of TARGETS) {
      assert.ok(known.has(t.file), `${f}: ${t.name} has unknown file ${t.file}`);
      for (const a of t.alts || [{ from: t.from, to: t.to }]) {
        assert.ok(a.from && a.to && a.from !== a.to, `${f}: ${t.name}`);
        assert.ok(!a.from.includes(a.to), `${f}: ${t.name}: to is inside from, so it would always look applied`);
        // Its from survives patching: a to that no longer matches exactly (an edit, line endings) would insert it again.
        if (a.to.includes(a.from)) assert.ok(t.marker && a.to.includes(t.marker) && !a.from.includes(t.marker), `${f}: ${t.name}: to keeps its from, so it needs a marker from the added text`);
      }
      names.add(`${f}:${t.name}`);
    }
  }
  assert.ok(names.size >= 27);
});

test('the image store directory is the same in the patch constants and in store.mjs', async () => {
  const { IMAGE_STORE_DIR, CONFIG_JSON } = require('../../patches/lib/vane.js');
  const { storeDirFor } = await import('../image/store.mjs');
  assert.equal(storeDirFor(CONFIG_JSON).split(String.fromCharCode(92)).join('/'), IMAGE_STORE_DIR);
});

test('the serving patch adds a GET without touching the POST handler', () => {
  const { TARGETS: [t] } = require('../../patches/patch-image-serve.js');
  assert.ok(t.to.includes('{GET:()=>fane_img,POST:()=>i}'));
  assert.ok(t.to.endsWith('async function i(a){'));
  const bundle = 'x;' + t.from + 'try{let b=await a.formData()}catch(a){}}';
  const out = planPatch({ [t.file]: `(()=>{try{${bundle.replace('x;', '')}}catch(e){}})()` }, [t]);
  assert.deepEqual(out.errors, []);
});

test('the answer marker is the same in the hook and in the browser patch', async () => {
  const { IMAGE_ANSWER_MARKER } = require('../../patches/lib/vane.js');
  const { ANSWER_MARKER, tagged } = await import('../image/present.mjs');
  assert.equal(ANSWER_MARKER, IMAGE_ANSWER_MARKER);
  assert.ok(tagged('x').endsWith(ANSWER_MARKER));
  const { TARGETS: [t] } = require('../../patches/patch-image-ui.js');
  assert.ok(t.to.includes(`!h.includes(${JSON.stringify(ANSWER_MARKER)})`));
});

test('the settings gear patch makes a labelled, keyboard-operable button and keeps its click', () => {
  const { TARGETS } = require('../../patches/patch-theme-toggle.js');
  const gear = TARGETS.find(t => t.name === 'settings gear is a labelled button');
  assert.ok(gear);
  for (const need of ['role:"button"', 'tabIndex:0', '"aria-label":"Settings"', '"Enter"===k.key', '" "===k.key', 'k.preventDefault()']) assert.ok(gear.to.includes(need), need);
  assert.ok(gear.to.includes(gear.from)); // the original onClick and icon are kept
  const out = planPatch({ [gear.file]: `var f=(0,s.jsx)("div",{className:"c",${gear.from};` }, [gear]);
  assert.deepEqual([out.errors, planPatch(out.next, [gear]).applied], [[], []]); // applies once, then a no-op
});

test('the new-chat patch resets only when the address is "/" with messages on screen', () => {
  const { TARGETS } = require('../../patches/patch-new-chat.js');
  assert.equal(TARGETS.length, 1);
  const [effect] = TARGETS;
  assert.ok(effect.to.includes('"/"===location.pathname&&S.length>0&&(document.title="Chat - Vane",g(void 0),M([])')); // not on a new chat's own "/", which has no messages
  assert.ok(effect.to.endsWith('f(!1))}),')); // no dependency list: runs on each render, the address is read live
  assert.ok(effect.to.startsWith(effect.from)); // Vane's own chat-id effect is kept
  assert.ok(!effect.to.includes('usePathname')); // Vane's import of next/navigation does not have it
  const out = planPatch({ [effect.file]: `var x=()=>{let t={};${effect.from}0};` }, TARGETS);
  assert.deepEqual([out.errors, planPatch(out.next, TARGETS).applied], [[], []]);
});

test('the Fane link patch adds one nav item that opens the page in a new tab, in both bars', () => {
  const { FANE_PAGE_URL } = require('../../patches/lib/vane.js');
  const { TARGETS } = require('../../patches/patch-ui-fane-link.js');
  const item = TARGETS.find(t => t.name === 'fane link nav item');
  assert.ok(item.to.includes(`href:${JSON.stringify(FANE_PAGE_URL)}`) && item.to.includes('label:"Fane"'));
  assert.ok(FANE_PAGE_URL.startsWith('https://')); // an external page: the item must not be a same-tab route
  const tabs = TARGETS.filter(t => t.name.startsWith('fane link opens in a new tab'));
  assert.equal(tabs.length, 2); // desktop sidebar and phone bottom bar
  for (const t of tabs) assert.ok(t.to.includes('target:e.external?"_blank"') && t.to.includes('rel:e.external?"noopener"'));
});

test('patch-image-chat runs together with patch-image-serve, so a failing serve target leaves no hook with dead links', () => {
  const src = readFileSync(new URL('../../patches/patch-image-chat.js', import.meta.url), 'utf8');
  assert.match(src, /run\('patch-image-chat', \[\.\.\.TARGETS, \.\.\.require\('\.\/patch-image-serve'\)\.TARGETS\]\)/);
});

test('run: a write that fails leaves every bundle as it was', async () => {
  const { mkdtempSync, mkdirSync, readFileSync: read, rmSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run } = require('../../patches/lib/apply-targets.js');
  const dir = mkdtempSync(join(tmpdir(), 'fane-patch-'));
  const a = join(dir, 'a.js'), b = join(dir, 'b.js');
  writeFileSync(a, 'var a=1;');
  writeFileSync(b, 'var b=1;');
  mkdirSync(`${b}.fane-tmp`); // the second write fails
  try {
    assert.throws(() => run('t', [{ name: 'a', file: a, from: 'a=1', to: 'a=2' }, { name: 'b', file: b, from: 'b=1', to: 'b=2' }]));
    assert.deepEqual([read(a, 'utf8'), read(b, 'utf8'), existsSync(`${a}.fane-tmp`)], ['var a=1;', 'var b=1;', false]);
    rmSync(`${b}.fane-tmp`, { recursive: true });
    run('t', [{ name: 'a', file: a, from: 'a=1', to: 'a=2' }, { name: 'b', file: b, from: 'b=1', to: 'b=2' }]);
    assert.deepEqual([read(a, 'utf8'), read(b, 'utf8'), read(`${a}.bak`, 'utf8')], ['var a=2;', 'var b=2;', 'var a=1;']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run: a failing backup write leaves every bundle, and the backups this run made, as they were', async () => {
  const realFs = await import('node:fs');
  const { mkdtempSync, readFileSync: read, rmSync, writeFileSync, existsSync } = realFs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run } = require('../../patches/lib/apply-targets.js');
  const dir = mkdtempSync(join(tmpdir(), 'fane-patch-'));
  const a = join(dir, 'a.js'), b = join(dir, 'b.js');
  writeFileSync(a, 'var a=1;');
  writeFileSync(b, 'var b=1;');
  const io = new Proxy(realFs, { get: (fs, key) => key !== 'writeFileSync' ? fs[key] : (f, ...rest) => {
    if (String(f) === `${b}.bak`) throw new Error('disk full');
    return fs.writeFileSync(f, ...rest);
  } });
  try {
    const targets = [{ name: 'a', file: a, from: 'a=1', to: 'a=2' }, { name: 'b', file: b, from: 'b=1', to: 'b=2' }];
    assert.throws(() => run('t', targets, io), /disk full/);
    assert.deepEqual([read(a, 'utf8'), read(b, 'utf8')], ['var a=1;', 'var b=1;']);
    assert.deepEqual([a, b].flatMap(f => [`${f}.fane-tmp`, `${f}.bak`]).filter(existsSync), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('patch-scrape-guard: the injected private-address rule gives the same answers as isPrivateAddress', async () => {
  const { PRIVATE_ADDRESS } = require('../../patches/lib/vane.js');
  const { isPrivateAddress } = await import('../image/download.mjs');
  const { isIP } = await import('node:net');
  const injected = new Function(`return ${PRIVATE_ADDRESS}`)();
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '172.32.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.128.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '8.8.8.8', '93.184.216.34', '::1', '::', 'fc00::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '::ffff:808:808', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2606:4700::1111', '2001:4860:4860::8888', '3fff::1', '4000::1']) {
    assert.equal(injected(ip, isIP), isPrivateAddress(ip), ip);
  }
});

test('patch-scrape-guard: a page cannot reach a private host or send data, and a redirect to one fails the scrape', async () => {
  const { TARGETS } = require('../../patches/patch-scrape-guard.js');
  const net = await import('node:net');
  const fakeScraper = 'var d=c(32325),e=c(40131),f=c(24425);class g{static async scrape(a){let b=await this.browser.newContext({userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"});await b.addInitScript(()=>{});let c=await b.newPage();try{await c.goto(a,{waitUntil:"domcontentloaded",timeout:this.NAVIGATION_TIMEOUT}),await c.waitForTimeout(500);return{title:"read"}}catch(b){return{title:"Failed to scrape"}}finally{await b.close()}}}var OUT=g;';
  const out = planPatch({ [TARGETS[0].file]: fakeScraper }, TARGETS);
  assert.deepEqual([out.errors, out.applied.length, planPatch(out.next, TARGETS).applied], [[], 3, []]);

  const dns = { 'a.example': ['93.184.216.34'], 'rebind.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '127.0.0.1'] };
  const lookups = [];
  const fakeRequire = (name) => name === 'node:net' ? net : name === 'node:dns'
    ? { promises: { lookup: async (h) => { lookups.push(h); if (!dns[h]) throw new Error('ENOTFOUND'); return dns[h].map(address => ({ address })); } } }
    : require(name);
  const Scraper = new Function('require', 'c', 'console', out.next[TARGETS[0].file] + ';return OUT')(fakeRequire, () => ({}), { log() {} });

  // One scrape against a fake browser: the page makes `requests` (each [method, url]) and the load ends at a
  // response whose redirect chain is `hops` (oldest first).
  const scrape = async (url, { requests = [], hops = [url] } = {}) => {
    const decisions = [];
    let options;
    const chain = hops.reduce((from, u) => ({ url: () => u, redirectedFrom: () => from }), null);
    Scraper.browser = { newContext: async (o) => {
      options = o;
      let handler;
      return {
        route: async (pattern, h) => { assert.equal(pattern, '**/*'); handler = h; },
        addInitScript: async () => {}, close: async () => {},
        newPage: async () => ({
          goto: async () => {
            for (const [method, u] of requests) {
              await handler({ request: () => ({ url: () => u, method: () => method }), continue: async () => decisions.push(`continue ${method} ${u}`), abort: async () => decisions.push(`abort ${method} ${u}`) });
            }
            return { request: () => chain };
          },
          waitForTimeout: async () => {},
        }),
      };
    } };
    const result = await Scraper.scrape(url);
    return { result, decisions, options };
  };

  const r = await scrape('https://a.example/page', { requests: [
    ['GET', 'https://a.example/page'], ['POST', 'https://a.example/collect'], ['GET', 'http://127.0.0.1:3000/api/config'], ['POST', 'http://127.0.0.1:3000/api/config'],
    ['GET', 'http://localhost:3000/api/config'], ['GET', 'http://[::1]:3000/'], ['GET', 'https://rebind.example/x'], ['GET', 'https://mixed.example/x'], ['GET', 'https://unknown.example/x'],
    ['GET', 'data:text/plain,hi'],
  ] });
  assert.equal(r.options.serviceWorkers, 'block');
  assert.deepEqual(r.decisions, [
    'continue GET https://a.example/page', 'abort POST https://a.example/collect', 'abort GET http://127.0.0.1:3000/api/config', 'abort POST http://127.0.0.1:3000/api/config',
    'abort GET http://localhost:3000/api/config', 'abort GET http://[::1]:3000/', 'abort GET https://rebind.example/x', 'abort GET https://mixed.example/x', 'abort GET https://unknown.example/x',
    'continue GET data:text/plain,hi',
  ]);
  assert.equal(lookups.filter(h => h === 'a.example').length, 1, 'a name is looked up once per scrape');
  assert.equal(r.result.title, 'read');

  assert.equal((await scrape('https://a.example/p', { hops: ['https://a.example/p', 'https://a.example/q'] })).result.title, 'read');
  assert.equal((await scrape('https://a.example/p', { hops: ['https://a.example/p', 'http://127.0.0.1:3000/api/config'] })).result.title, 'Failed to scrape');
  assert.equal((await scrape('https://a.example/p', { hops: ['https://a.example/p', 'https://rebind.example/'] })).result.title, 'Failed to scrape');
  assert.equal((await scrape('http://127.0.0.1:3000/api/config')).result.title, 'Failed to scrape');
  assert.equal((await scrape('file:///etc/passwd')).result.title, 'Failed to scrape');
});

// Phase 0 V5 (fixed in Phase 8.2): a rename that throws after the first bundle was renamed.
async function renameFailure() {
  const realFs = await import('node:fs');
  const { mkdtempSync, writeFileSync } = realFs;
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run } = require('../../patches/lib/apply-targets.js');
  const dir = mkdtempSync(join(tmpdir(), 'fane-patch-'));
  const a = join(dir, 'a.js'), b = join(dir, 'b.js');
  writeFileSync(a, 'var a=1;');
  writeFileSync(b, 'var b=1;');
  let failB = true;
  const io = new Proxy(realFs, { get: (fs, key) => key !== 'renameSync' ? fs[key] : (from, to) => {
    if (failB && String(to) === b) throw new Error('EPERM rename');
    return fs.renameSync(from, to);
  } });
  const targets = [{ name: 'a', file: a, from: 'a=1', to: 'a=2' }, { name: 'b', file: b, from: 'b=1', to: 'b=2' }];
  const state = () => Object.fromEntries([a, b].flatMap(f => [[`${f === a ? 'a' : 'b'}`, realFs.readFileSync(f, 'utf8')], [`${f === a ? 'a' : 'b'}.tmp`, realFs.existsSync(`${f}.fane-tmp`)], [`${f === a ? 'a' : 'b'}.bak`, realFs.existsSync(`${f}.bak`)]]));
  return { realFs, dir, io, run, targets, state, heal: () => { failB = false; } };
}

test('run: after a rename that threw and was rolled back, a rerun patches both bundles', async () => {
  const t = await renameFailure();
  try {
    assert.throws(() => t.run('t', t.targets, t.io), /EPERM rename/);
    t.heal();
    t.run('t', t.targets, t.io);
    assert.deepEqual(t.state(), { a: 'var a=2;', 'a.tmp': false, 'a.bak': true, b: 'var b=2;', 'b.tmp': false, 'b.bak': true });
  } finally { t.realFs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('run: a rename that throws puts every bundle back and leaves no temporary file or backup this run made', async () => {
  const t = await renameFailure();
  try {
    assert.throws(() => t.run('t', t.targets, t.io), /EPERM rename/);
    assert.deepEqual(t.state(), { a: 'var a=1;', 'a.tmp': false, 'a.bak': false, b: 'var b=1;', 'b.tmp': false, 'b.bak': false });
  } finally { t.realFs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('planPatch reports one status per target: applied, upgraded, already, skipped, error', () => {
  const ts = [
    T({ name: 'fresh', from: 'a=1', to: 'a=2', ladder: ['fresh'] }),
    T({ name: 'up', alts: [{ from: 'b=0', to: 'b=3' }, { from: 'b=1', to: 'b=3' }], ladder: ['fresh', 'V1'] }),
    T({ name: 'done', from: 'c=0', to: 'c=2' }),
    T({ name: 'opt', from: 'zzz', to: 'q', optional: 'needs other patch' }),
    T({ name: 'bad', from: 'nope', to: 'x', ladder: ['fresh'] }),
  ];
  const r = planPatch({ [F]: 'var a=1,b=1,c=2;' }, ts);
  assert.deepEqual(r.status, [['fresh', 'applied'], ['up', 'upgraded'], ['done', 'already'], ['opt', 'skipped'], ['bad', 'error']].map(([name, status]) => ({ name, status })));
  assert.deepEqual([r.applied, r.skipped.length, r.errors], [['fresh', 'up'], 1, ['bad: expected 1 match, found 0 (known versions: fresh)']]);
});

test('a "found 0" error names the known versions only when the target has a ladder', () => {
  const alts = [{ from: 'x()', to: 'X()' }, { from: 'y()', to: 'Y()' }];
  assert.deepEqual(planPatch({ [F]: 'z();' }, [T({ alts, ladder: ['fresh', 'V1'] })]).errors, ['t: expected 1 match, found 0/0 (known versions: fresh, V1)']);
  assert.deepEqual(planPatch({ [F]: 'z();' }, [T({ alts })]).errors, ['t: expected 1 match, found 0/0']);
});

test('run: the end-of-run line counts every target in place and keeps the words apply.mjs looks for', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run } = require('../../patches/lib/apply-targets.js');
  const dir = mkdtempSync(join(tmpdir(), 'fane-patch-'));
  const f = join(dir, 'a.js');
  writeFileSync(f, 'var a=1,b=2;');
  const lines = [];
  const log = console.log;
  console.log = (l) => lines.push(l);
  try {
    const a = { name: 'a', file: f, from: 'a=1', to: 'a=2' };
    run('t', [a, { name: 'b', file: f, from: 'b=2', to: 'b=3' }]);
    run('t', [a]);
    run('t', [{ ...a, name: 'a2', from: 'a=2', to: 'a=2/*m*/', marker: '/*m*/' }, { name: 'o', file: f, from: 'zzz', to: 'q', optional: 'x' }, { ...a, from: 'b=3', to: 'b=4', ladder: undefined }]);
  } finally { console.log = log; rmSync(dir, { recursive: true, force: true }); }
  assert.equal(lines[0], 't: patched 2 of 2 targets (2 changed now; backups: *.bak)');
  assert.equal(lines[1], `t: changed ${f}`); // one line per file written: apply.mjs decides the restart from these
  assert.equal(lines[2], 't: already patched'); // nothing written, no "changed" line
  assert.equal(lines[3], 't: skipped o (x)');
  assert.match(lines[4], /^t: patched 2 of 3 targets \(2 changed now, 1 optional skipped; backups: \*\.bak\)$/);
  assert.equal(lines[5], `t: changed ${f}`);
  assert.equal(lines.length, 6);
  for (const l of [lines[0], lines[4]]) assert.ok(/patched/.test(l) && !/already patched/.test(l), l);
});

test('run: one "changed" line per file written, for every file of a multi-file run (patch-image-chat with patch-image-serve)', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run } = require('../../patches/lib/apply-targets.js');
  const dir = mkdtempSync(join(tmpdir(), 'fane-patch-'));
  const [a, b, c] = ['a.js', 'b.js', 'c.js'].map(n => join(dir, n));
  for (const f of [a, b, c]) writeFileSync(f, 'var x=1;');
  const lines = [];
  const log = console.log;
  console.log = (l) => lines.push(l);
  try {
    run('t', [{ name: 'a', file: a, from: 'x=1', to: 'x=2' }, { name: 'b', file: b, from: 'x=1', to: 'x=2' }, { name: 'c', file: c, from: 'x=2', to: 'x=2', optional: 'absent' }]);
  } finally { console.log = log; rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(lines.filter(l => l.includes(': changed ')), [`t: changed ${a}`, `t: changed ${b}`]);
});

test('every alts target that has a ladder has one label per alternative', () => {
  const dir = new URL('../../patches/', import.meta.url);
  for (const f of readdirSync(dir).filter(x => /^patch-.*\.js$/.test(x))) {
    for (const t of require(`../../patches/${f}`).TARGETS) {
      if (t.ladder === undefined) continue;
      assert.ok(t.alts && Array.isArray(t.ladder) && t.ladder.length === t.alts.length, `${f}: ${t.name}: ladder needs one label per alts entry`);
      assert.ok(t.ladder.every(l => typeof l === 'string' && l), `${f}: ${t.name}: labels are non-empty strings`);
    }
  }
});

// Phase 8.1 version ladder: every alternative of every target, built from its own from alone. The fixture goes in a
// .css-named file, which the engine does not parse, because a bare fragment is not a JavaScript program.
const allPatches = () => {
  const dir = new URL('../../patches/', import.meta.url);
  return readdirSync(dir).filter(x => /^patch-.*\.js$/.test(x)).sort().map(f => ({ f, TARGETS: require(`../../patches/${f}`).TARGETS }));
};
const noCr = (s) => s.replace(/\r/g, '');

test('version ladder: every alts entry of every target upgrades to the latest text and is then a no-op', () => {
  const file = '/sweep/bundle.css';
  let swept = 0;
  for (const { f, TARGETS } of allPatches()) {
    for (const t of TARGETS.filter(x => x.alts)) {
      const tt = { ...t, file };
      t.alts.forEach((alt, k) => {
        const where = `${f}: ${t.name}: alts[${k}]${t.ladder ? ' (' + t.ladder[k] + ')' : ''}`;
        const one = planPatch({ [file]: noCr(alt.from) }, [tt]);
        assert.deepEqual(one.errors, [], where);
        assert.ok(['applied', 'upgraded'].includes(one.status[0].status), where);
        assert.ok(isApplied(one.next[file], tt), where + ': the result holds a to (or the marker)');
        if (t.ladder) assert.equal(one.status[0].status, t.ladder[k].startsWith('fresh') ? 'applied' : 'upgraded', where);
        const two = planPatch(one.next, [tt]);
        assert.deepEqual([two.errors, two.applied, two.status[0].status, two.next[file] === one.next[file]], [[], [], 'already', true], where);
        swept++;
      });
    }
  }
  assert.ok(swept >= 30, String(swept));
});

// Cross-patch, target by target: fixtures are the targets' own fresh froms (the first alts entry labelled fresh, else the
// only from), one bundle per file, then every patch in file order. A target whose from only exists in another patch's
// output cannot be built from its from alone: it reports an error here and is listed in the log line, not failed.
// After the whole run, each target that applied reports "already" when run alone, so a marker that a later patch's
// edit removed shows up.
test('every patch in file order, then each target alone: whatever applied is reported as already applied', () => {
  const file = (t) => noCr(t.file) + '.css';
  const fresh = (t) => noCr(t.alts ? t.alts[Math.max(0, (t.ladder || []).findIndex(l => l === 'fresh'))].from : t.from);
  const bundles = {};
  const seen = new Set();
  for (const { TARGETS } of allPatches()) for (const t of TARGETS) {
    const key = file(t) + '|' + fresh(t);
    if (seen.has(key)) continue; // a target two patches share (RANK_ON_ORIGINAL_TEXT)
    seen.add(key);
    bundles[file(t)] = (bundles[file(t)] || '') + fresh(t) + '\n;/*gap*/\n';
  }
  let files = bundles;
  const applied = [], unbuilt = [];
  for (const { f, TARGETS } of allPatches()) for (const t of TARGETS) {
    const tt = { ...t, file: file(t) };
    const r = planPatch(files, [tt]);
    if (r.errors.length) { unbuilt.push(`${f}: ${t.name}`); continue; }
    if (r.status[0].status === 'applied' || r.status[0].status === 'upgraded') applied.push([f, tt]);
    files = r.next;
  }
  for (const [f, tt] of applied) {
    const again = planPatch(files, [tt]);
    assert.deepEqual([again.errors, again.status[0].status], [[], 'already'], `${f}: ${tt.name}`);
  }
  assert.ok(applied.length >= 40, 'applied ' + applied.length + ', unbuilt ' + unbuilt.length);
  console.log('# cross-patch fixtures: ' + applied.length + ' targets applied and re-checked, ' + unbuilt.length + ' not buildable from their own from: ' + unbuilt.join('; '));
});
