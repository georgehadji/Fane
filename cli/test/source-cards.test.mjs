// Tests the code patches/patch-source-cards.js injects into Vane's browser chunks: the chip merge in the chat code,
// the card data (CITE_ITEMS) and the chip component (CHIP), rendered with a stand-in for React.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TARGETS, CHIP, CITE_ITEMS } = require('../../patches/patch-source-cards.js');
const { TARGETS: CODE_TARGETS } = require('../../patches/patch-code-chat.js');
const { planPatch } = require('../../patches/lib/apply-targets.js');
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
  for (const t of TARGETS) assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(t.to), t.name);
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
