// Tests the code patches/patch-source-cards.js injects into Vane's browser chunks: the chip merge in the chat code,
// the card data (CITE_ITEMS) and the chip component (CHIP), rendered with a stand-in for React.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TARGETS, CHIP, CITE_ITEMS } = require('../../patches/patch-source-cards.js');
const { TARGETS: CODE_TARGETS } = require('../../patches/patch-code-chat.js');
const { planPatch, appliedNeedles } = require('../../patches/lib/apply-targets.js');
const { FILES } = require('../../patches/lib/vane.js');

const src = (url, title = 'T', content = '') => ({ content, metadata: { url, title } });

test('site names: the name under the public suffix, "file" names for uploads', () => {
  const S = [
    src('https://www.reddit.com/r/x/comments/1'), src('https://en.wikipedia.org/wiki/Fane'), src('https://www.bbc.co.uk/news/1'),
    src('https://www1.gsis.gr/'), src('https://arxiv.org/abs/1'), { content: '', metadata: { url: 'file_id://abc', title: 'a.pdf', fileName: 'notes.pdf' } },
  ];
  assert.deepEqual(CITE_ITEMS(S, '1,2,3,4,5,6').map(i => i.site), ['reddit', 'wikipedia', 'bbc', 'gsis', 'arxiv', 'notes.pdf']);
  const [r, , , , , f] = CITE_ITEMS(S, '1,2,3,4,5,6');
  assert.equal(r.host, 'reddit.com');
  assert.equal(r.icon, 'https://s2.googleusercontent.com/s2/favicons?sz=32&domain=reddit.com'); // the host only, not the page
  assert.deepEqual([f.host, f.icon], ['Uploaded file', '']);
});

test('numbers keep their order, repeats and unknown numbers drop; no source falls back to the link', () => {
  const S = [src('https://a.com/'), src('https://b.com/')];
  assert.deepEqual(CITE_ITEMS(S, ['2,1,2,9']).map(i => i.site), ['b', 'a']);
  assert.deepEqual(CITE_ITEMS(S, 'x', 'https://b.com/').map(i => i.site), ['b']);
  assert.deepEqual(CITE_ITEMS(undefined, '1', 'https://c.org/x').map(i => [i.site, i.title]), [['c', 'c.org']]);
  assert.deepEqual(CITE_ITEMS(S, '9'), []);
});

test('card text: the forum label is lifted out, Markdown goes, long text is cut at a word with an ellipsis', () => {
  const [hn] = CITE_ITEMS([src('https://news.ycombinator.com/item?id=1', 'T', '[Hacker News | 2025-03-14] **Batteries** last')], '1');
  assert.deepEqual([hn.label, hn.text], ['Hacker News | 2025-03-14', 'Batteries last']);
  const [md] = CITE_ITEMS([src('https://a.com/', 'T', '# Head\n- one [link](https://x.y) ![i](https://i.png)\n- `two` | three')], '1');
  assert.equal(md.text, 'Head one link two three');
  assert.equal(CITE_ITEMS([src('https://a.com/', 'T', '[Image] text')], '1')[0].label, ''); // only Fane's platform labels
  const [long] = CITE_ITEMS([src('https://a.com/', 'T', 'word '.repeat(100))], '1');
  assert.ok(long.text.endsWith('word…') && long.text.length <= 221, long.text);
});

// Vane's "[x]" rewrite in ChatProvider, as the pinned chunk has it.
const REWRITE = 'var rw=(s,l,d)=>{s=l.length>0?s.replace(/\\[([^\\]]+)\\]/g,(e,t)=>t.split(",").map(e=>e.trim()).map(e=>{let t=parseInt(e);if(isNaN(t)||t<=0)return`[${e}]`;let r=l[t-1],a=r?.metadata?.url;return a?`<citation href="${a}">${e}</citation>`:""}).join("")):s.replace(d,"");return s};';

test('chat code: one chip per bracket group and per run of spaced chips, in either order with patch-code-chat', () => {
  const mine = TARGETS.filter(t => t.file === FILES.chatClient);
  const code = CODE_TARGETS.filter(t => t.file === FILES.chatClient);
  const a = planPatch({ [FILES.chatClient]: REWRITE }, [...mine, ...code]);
  const b = planPatch({ [FILES.chatClient]: REWRITE }, [...code, ...mine]);
  assert.deepEqual([a.errors, b.errors], [[], []]);
  assert.equal(a.next[FILES.chatClient], b.next[FILES.chatClient]);
  const rw = eval(`${a.next[FILES.chatClient]}rw`);
  const l = [1, 2, 3, 4].map(n => src(`https://s${n}.com/`));
  assert.equal(rw('A [1, 4]. B [2] [3]\n[1] C [x]', l, /x/g),
    'A <citation href="https://s1.com/">1,4</citation>. B <citation href="https://s2.com/">2,3</citation>\n<citation href="https://s1.com/">1</citation> C [x]');
  assert.equal(rw('a[0] [2]<!--fane:code-answer-->', l, /x/g), 'a[0] [2]<!--fane:code-answer-->'); // code answers untouched
});

test('message code: the patched chip and its props parse, and the injected code is ASCII', () => {
  const bundle = 'var r={},c={},ee=({href:e,children:t})=>(0,r.jsx)("a",{href:e,target:"_blank",className:"bg-light-secondary dark:bg-dark-secondary px-1 rounded ml-1 no-underline text-xs text-black/70 dark:text-white/70 relative",children:t});var o=p=>({overrides:{citation:{component:ee}}});';
  const r = planPatch({ [FILES.messageClient]: bundle }, TARGETS.filter(t => t.file === FILES.messageClient));
  assert.deepEqual(r.errors, []);
  assert.ok(r.next[FILES.messageClient].includes('citation:{component:ee,props:{sources:p}}'));
  for (const t of TARGETS) for (const n of appliedNeedles(t)) assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(n), t.name); // the engine strips a CRLF checkout's \r
});

// A stand-in for React: hooks return their initial state (`open` forced by the test), jsx builds plain objects.
function render(props, open = false) {
  let first = true;
  const C = {
    useState: (v) => { const s = first ? open : v; first = false; return [s, () => {}]; },
    useRef: (v) => ({ current: v }), useEffect: () => {}, useLayoutEffect: () => {}, useId: () => ':r1:',
  };
  const R = { jsx: (type, p) => ({ type, ...p }), jsxs: (type, p) => ({ type, ...p }) };
  return CHIP(props, R, C, CITE_ITEMS);
}
const text = (n) => (n == null || typeof n !== 'object' ? String(n ?? '') : [].concat(n.children).map(text).join(''));
const find = (n, cls) => (n && typeof n === 'object' ? (String(n.className).split(' ').includes(cls) ? n : [].concat(n.children).map(c => find(c, cls)).find(Boolean)) : undefined);

test('chip: the first source\'s site and "+1"; open, the card shows the first source and a 1/2 pager', () => {
  const sources = [src('https://www.reddit.com/r/x', 'EV threads', 'Owners say'), src('https://arxiv.org/abs/1', 'Paper')];
  const closed = render({ href: 'https://www.reddit.com/r/x', children: ['1,2'], sources });
  const chip = find(closed, 'fane-cite-chip');
  assert.deepEqual([text(chip), chip.href, chip['aria-describedby']], ['reddit +1', 'https://www.reddit.com/r/x', undefined]);
  assert.equal(find(closed, 'fane-cite-card'), undefined);

  const opened = render({ href: 'https://www.reddit.com/r/x', children: ['1,2'], sources }, true);
  const card = find(opened, 'fane-cite-card');
  assert.equal(find(opened, 'fane-cite-chip')['aria-describedby'], card.id);
  assert.equal(text(find(card, 'fane-cite-title')), 'EV threads');
  assert.equal(text(find(card, 'fane-cite-text')), 'Owners say');
  assert.equal(text(find(card, 'fane-cite-pager')), '‹1/2›');
  assert.equal(find(render({ href: 'https://a.com/', children: ['1'], sources: [src('https://a.com/')] }, true), 'fane-cite-pager'), undefined);
});

// Phase 0 V3: a stateful stand-in for React (slots by call order, setState re-renders) so the hover timer, focus and
// the touch handlers can interleave as in a browser.
function mount(props) {
  const slots = []; let i = 0, tree;
  const C = {
    useState: (v) => { const k = i++; if (!(k in slots)) slots[k] = v; return [slots[k], (n) => { slots[k] = typeof n === 'function' ? n(slots[k]) : n; draw(); }]; },
    useRef: (v) => { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useEffect: () => { i++; }, useLayoutEffect: () => { i++; }, useId: () => ':r1:',
  };
  const R = { jsx: (type, p) => ({ type, ...p }), jsxs: (type, p) => ({ type, ...p }) };
  function draw() { i = 0; tree = CHIP(props, R, C, CITE_ITEMS); }
  draw();
  return { get tree() { return tree; }, get chip() { return find(tree, 'fane-cite-chip'); }, get open() { return !!find(tree, 'fane-cite-card'); } };
}
const click = (m, pointerType) => { let prevented = false; m.chip.onClick({ preventDefault() { prevented = true; } }); return prevented; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chipProps = { href: 'https://a.com/', children: ['1'], sources: [src('https://a.com/')] };

test('chip tap: a hover timer that fires between pointerdown and click leaves the card open and the first tap does not navigate', async () => {
  const m = mount(chipProps);
  m.tree.onPointerEnter({ pointerType: 'mouse' }); // starts the 150 ms timer (a hybrid device)
  m.chip.onPointerDown({ pointerType: 'touch' }); // wasOpen = false
  await sleep(250); // the timer fires here
  assert.equal(m.open, true);
  assert.equal(click(m), true); // wasOpen is the value at pointerdown, so this tap is the "open" tap: no navigation
  assert.equal(m.open, true); // and the card is not toggled shut
});

test('chip tap: a second tap on the open card navigates; the card closing between pointerdown and click does not stop it', async () => {
  const m = mount(chipProps);
  m.chip.onPointerDown({ pointerType: 'touch' }); assert.equal(click(m), true); assert.equal(m.open, true); // first tap opens
  m.chip.onPointerDown({ pointerType: 'touch' }); // wasOpen = true
  m.tree.onPointerLeave({ pointerType: 'mouse' }); // set(false, 120) fires before the click
  await sleep(200);
  assert.equal(m.open, false);
  assert.equal(click(m), false);
});

test('chip tap: a keyboard click after a touch tap navigates', () => {
  const m = mount(chipProps);
  m.chip.onPointerDown({ pointerType: 'touch' }); click(m); // the touch tap opened the card (wasOpen stays false)
  assert.equal(click(m), false); // Enter on the focused chip: no pointerdown first
});

test('chip tap: a mouse pointerdown after a touch pointerdown that never clicked does not swallow the click', () => {
  const m = mount(chipProps);
  m.chip.onPointerDown({ pointerType: 'touch' }); // a scroll gesture: no click follows
  m.chip.onPointerDown({ pointerType: 'mouse' });
  assert.equal(click(m), false);
  assert.equal(m.open, false);
});

// The chip's machine, driven the way a browser does: handlers on the tree, document/window listeners the effects add,
// and mocked timers. The state is read from what it does (see SIGNATURE), because CHIP keeps it in a ref.
function mountFx(props) {
  const slots = []; const fx = []; let i = 0, tree, eff = 0, pending = [];
  const reg = () => ({ l: {}, addEventListener(t, f) { (this.l[t] ??= []).push(f); }, removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter(x => x !== f); } });
  const doc = Object.assign(reg(), { activeElement: null, documentElement: { clientWidth: 1000 } });
  const win = Object.assign(reg(), { innerHeight: 800 });
  const same = (a, b) => a && b && a.length === b.length && a.every((v, k) => v === b[k]);
  const C = {
    useState: (v) => { const k = i++; if (!(k in slots)) slots[k] = v; return [slots[k], (n) => { const x = typeof n === 'function' ? n(slots[k]) : n; if (Object.is(x, slots[k])) return; slots[k] = x; draw(); }]; },
    useRef: (v) => { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useEffect: (fn, deps) => { pending.push([eff++, fn, deps]); }, useLayoutEffect: () => {}, useId: () => ':r1:',
  };
  const els = {};
  const R = { jsx: (type, p) => { const n = { type, ...p }; if (p.ref) { p.ref.current = els[p.className] ??= { inside: true, contains: (x) => !!x && x.inside === true, focus() { if (doc.activeElement !== this) { doc.activeElement = this; tree.onFocus(); } }, getBoundingClientRect: () => ({}) }; } return n; } };
  R.jsxs = R.jsx;
  function draw() {
    i = 0; eff = 0; pending = []; tree = CHIP(props, R, C, CITE_ITEMS);
    for (const [k, fn, deps] of pending) {
      if (fx[k] && deps && same(deps, fx[k].deps)) continue;
      if (fx[k] && typeof fx[k].undo === 'function') fx[k].undo();
      fx[k] = { deps }; fx[k].undo = fn(); // a state change inside the effect redraws before it returns
    }
  }
  const prev = [globalThis.document, globalThis.window];
  globalThis.document = doc; globalThis.window = win;
  draw();
  const emit = (target, type, e) => (target.l[type] || []).slice().forEach(f => f(e));
  const m = {
    get tree() { return tree; }, get chip() { return find(tree, 'fane-cite-chip'); }, get open() { return !!find(tree, 'fane-cite-card'); },
    get page() { return text(find(tree, 'fane-cite-pager')); },
    chipEl: () => els['fane-cite-chip'], doc, emit,
    enter: () => tree.onPointerEnter({ pointerType: 'mouse' }), leave: () => tree.onPointerLeave({ pointerType: 'mouse' }),
    focus: () => { doc.activeElement = m.chipEl(); tree.onFocus(); }, blur: () => { doc.activeElement = null; tree.onBlur({ relatedTarget: null }); },
    tap: () => { m.chip.onPointerDown({ pointerType: 'touch' }); return click(m); },
    esc: () => emit(doc, 'keydown', { key: 'Escape' }), away: () => emit(doc, 'pointerdown', { target: {} }), scroll: (target = {}) => emit(win, 'scroll', { target }),
    resize: () => emit(win, 'resize', {}),
    timer: () => mock.timers.tick(200), end: () => { [globalThis.document, globalThis.window] = prev; },
  };
  return m;
}

// What each state does: [card shown, after the timer, after a blur, after a focus, after a focus then a blur].
const SIGNATURE = {
  closed: [false, false, false, true, false], over: [false, false, false, true, true], opening: [false, true, false, true, true],
  open: [true, true, false, true, false], openOver: [true, true, true, true, true], closing: [true, false, false, true, false],
  muted: [false, false, false, false, false],
};
const PATH = {
  closed: [], opening: ['enter'], open: ['focus'], openOver: ['enter', 'timer'], over: ['enter', 'timer', 'scroll'],
  closing: ['focus', 'leave'], muted: ['focus', 'esc'],
};
function replay(steps) {
  mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout'] });
  const m = mountFx(chipProps);
  try { for (const s of steps) m[s](); return m; } catch (e) { m.end(); throw e; }
}
function signature(steps) {
  const seen = (more) => { const m = replay([...steps, ...more]); const o = m.open; m.end(); return o; };
  return [seen([]), seen(['timer']), seen(['blur']), seen(['focus']), seen(['focus', 'blur'])];
}
const nameOf = (steps) => { const s = JSON.stringify(signature(steps)); return Object.keys(SIGNATURE).find(k => JSON.stringify(SIGNATURE[k]) === s) ?? s; };

test('chip machine: every state is reached by its path and tells itself apart by what it does', () => {
  for (const [name, steps] of Object.entries(PATH)) assert.equal(nameOf(steps), name, name);
});

// One row per transition of T in patches/patch-source-cards.js (and the no-ops worth pinning): [from, event, to].
// 'tap' is a touch pointerdown and its click; esc/away/scroll/resize reach CHIP through the listeners its effect adds.
// Esc is muted only when the focus is on the chip (open, closing); openOver's path has none, so its Esc closes (see below).
const ROWS = [
  ['closed', 'enter', 'opening'], ['closed', 'focus', 'open'], ['closed', 'tap', 'open'], ['closed', 'blur', 'closed'], ['closed', 'leave', 'closed'],
  ['over', 'enter', 'opening'], ['over', 'leave', 'closed'], ['over', 'focus', 'openOver'], ['over', 'tap', 'openOver'], ['over', 'blur', 'over'],
  ['opening', 'leave', 'closed'], ['opening', 'focus', 'openOver'], ['opening', 'tap', 'openOver'], ['opening', 'timer', 'openOver'], ['opening', 'blur', 'opening'],
  ['opening', 'esc', 'opening'], ['opening', 'away', 'opening'], ['opening', 'scroll', 'opening'], // no card yet, so no listeners
  ['open', 'enter', 'openOver'], ['open', 'leave', 'closing'], ['open', 'blur', 'closed'], ['open', 'esc', 'muted'], ['open', 'away', 'closed'],
  ['open', 'scroll', 'closed'], ['open', 'resize', 'closed'], ['open', 'focus', 'open'],
  ['openOver', 'leave', 'closing'], ['openOver', 'esc', 'closed'], ['openOver', 'away', 'over'], ['openOver', 'scroll', 'over'], ['openOver', 'blur', 'openOver'],
  ['closing', 'enter', 'openOver'], ['closing', 'leave', 'closing'], ['closing', 'focus', 'open'], ['closing', 'blur', 'closed'], ['closing', 'esc', 'muted'],
  ['closing', 'away', 'closed'], ['closing', 'scroll', 'closed'], ['closing', 'timer', 'closed'],
  ['muted', 'enter', 'opening'], ['muted', 'focus', 'closed'], ['muted', 'blur', 'closed'], ['muted', 'tap', 'open'], ['muted', 'leave', 'muted'],
];
for (const [from, event, to] of ROWS) {
  test(`chip machine: ${from} --${event}--> ${to}`, () => {
    assert.equal(nameOf([...PATH[from], event]), to);
  });
}

test('chip machine: Esc from a focused button in the card puts the focus back on the chip and does not reopen the card', () => {
  const m = replay(['focus']);
  m.doc.activeElement = { inside: true }; // the pager's button
  m.esc();
  assert.equal(m.doc.activeElement, m.chipEl());
  assert.equal(m.open, false);
  m.end();
  assert.equal(nameOf(['focus', 'esc']), 'muted'); // chip already focused: no focus event comes, a blur clears it
});

test('chip machine: Esc with the focus outside the chip closes the card and is not muted', () => {
  const m = replay(['enter', 'timer']);
  m.esc();
  assert.equal(m.open, false); m.end();
  assert.equal(nameOf(['enter', 'timer', 'esc']), 'closed');
});

test('chip machine: Esc with the chip focused and the pointer on it mutes, and clears the hover', () => {
  assert.equal(nameOf(['focus', 'enter', 'esc']), 'muted');
});

test('chip machine: Esc clears the hover, so a later focus then blur closes the card', () => {
  assert.deepEqual(signature(['focus', 'enter', 'esc', 'blur']), SIGNATURE.closed); // not 'over', which a stale hover would leave
});

test('chip machine: scrolling inside the card leaves it open, scrolling the page closes it', () => {
  const m = replay(['focus']);
  m.scroll({ inside: true }); assert.equal(m.open, true);
  m.scroll({}); assert.equal(m.open, false);
  m.end();
});

test('chip machine: a touch pointer does not hover', () => {
  const m = replay([]);
  m.tree.onPointerEnter({ pointerType: 'touch' }); m.timer(); assert.equal(m.open, false);
  m.end();
});

test('chip machine: the pager page is data: it turns while the card is open and resets when the card closes', () => {
  const sources = [src('https://a.com/', 'A'), src('https://b.com/', 'B')];
  mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout'] });
  const m = mountFx({ href: 'https://a.com/', children: ['1,2'], sources });
  m.focus(); assert.equal(m.page, '‹1/2›');
  find(m.tree, 'fane-cite-pager').children[2].onClick({ preventDefault() {} }); assert.equal(m.page, '‹2/2›');
  m.esc(); assert.equal(m.open, false);
  m.blur(); m.focus(); assert.equal(m.page, '‹1/2›');
  m.end();
});
