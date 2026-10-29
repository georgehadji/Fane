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
  assert.equal(fonts.length, 9); // Commissioner: 3 subsets; Literata: 3 subsets, roman and italic
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
  for (const old of [type.TYPE_V1, type.TYPE_V2, type.TYPE_V3].flatMap(v => [`x{}${end}\n${v}\n\n${colors.COLORS}\n`, `x{}${end}\n${colors.COLORS}\n\n${v}\n`])) {
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

test('patch-discover-greek: the Discover search adds every Greek site and query of the topic, in Greek; a failing one adds nothing', async () => {
  const { GREEK, TARGETS } = require('../../patches/patch-discover-greek.js');
  assert.deepEqual(Object.keys(GREEK), ['tech', 'finance', 'art', 'sports', 'entertainment']); // Vane's Discover topics
  // the patched search, run with a fake SearXNG client
  const route = `(async (b, d, v) => { let e; ${TARGETS[0].from}; return e; })`;
  const r = planPatch({ [FILES.discoverRoute]: route }, TARGETS);
  assert.deepEqual(r.errors, []);
  const calls = [];
  const v = { n: async (q, { language }) => { calls.push([q, language]); if (q.includes('lifo.gr')) throw new Error('bing down'); return { results: [{ url: `${language}:${q}` }] }; } };
  const english = { links: ['wired.com'], query: ['AI'] };
  const run = async (topic) => (await eval(r.next[FILES.discoverRoute])(new URLSearchParams(topic ? { topic } : {}), english, v)).map(s => s.url);
  const art = await run('art');
  assert.equal(art.length, 1 + 3 * 2 - 2); // lifo.gr's two searches failed and gave nothing
  assert.ok(art.includes('el:site:efsyn.gr πολιτισμός') && art.includes('en:site:wired.com AI'));
  assert.ok(calls.filter(([, l]) => l === 'el').every(([q]) => /^site:\S+\.(gr|com) /.test(q)));
  assert.equal((await run()).filter(u => u.startsWith('el:')).length, 6); // no topic: tech, as in Vane
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

test('patch-quality-mode: Quality research stops after two rounds that found no new page', () => {
  const { TARGETS } = require('../../patches/patch-quality-mode.js');
  const loop = TARGETS.filter(t => /pages seen|without a new page/.test(t.name));
  // Vane's research loop, cut down to the lines the two targets edit.
  const fake = 'var research=(rounds,b,console)=>{let used=0,c=[],d=rounds.length,f={b:()=>""},i=0;for(let g=0;g<d;g++){let l=(0,f.b)(i,b.config.mode,g,d,b.config.fileIds);used++;let r=rounds[g];c.push(...r)}let l=c.filter(a=>"search_results"===a.type).flatMap(a=>a.results),m=new Map,n=l.map(a=>a);return used};';
  const out = planPatch({ [loop[0].file]: fake }, loop);
  assert.deepEqual([out.errors, out.applied.length, planPatch(out.next, loop).applied], [[], 2, []]);
  const research = new Function(`${out.next[loop[0].file]}return research`)();
  const quiet = { log() {} };
  const found = (...urls) => [{ type: 'search_results', results: urls.map(url => ({ metadata: { url } })) }];
  const run = (mode, rounds) => research(rounds, { config: { mode } }, quiet);
  assert.equal(run('quality', [found('a'), found('b'), found('c'), found('d')]), 4);
  assert.equal(run('quality', [found('a', 'b'), found('a'), found('b'), found('c')]), 3);
  assert.equal(run('quality', [found('a'), found('a'), found('b'), found('b'), found('b')]), 5); // a new page resets the count
  assert.equal(run('quality', [[], [], found('a'), found('b')]), 4); // rounds before the first search do not count
  assert.equal(run('balanced', [found('a'), found('a'), found('a'), found('a')]), 4);
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
