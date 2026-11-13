// Vane: Discover cards load their pictures lazily and name the outlet.
// The Discover page fetches its stories in the browser (the server page renders only the spinner), so these edits are
// to one browser chunk (FILES.discoverClient, served with max-age=0): a normal reload picks them up, no restart.
//  - every card picture gets loading="lazy" and decoding="async": a topic holds 12-30 stories and the page fetched all
//    their pictures at once, though only the first row is on screen. The picture boxes already keep their size
//    (aspect-video, fixed row height), so nothing moves when one arrives.
//  - an outlet line (the address's host without "www.") sits above each title, because a card said nothing about who
//    wrote the story until the summary opened. It is plain text: a card is one link already, and a link inside it
//    would be a link inside a link.
// The three cards (grid card, row with the picture left, row with the picture right) share long strings, so each
// target names the text just before it, which is unique. Written for the pinned chunk, where the story is `e` and
// the JSX runtime `a`.
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');

// Injected as source text: no imports, no closure, ASCII.
function HOST(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

const OUTLET = `(0,a.jsx)("p",{"data-fane-outlet":"",children:(${HOST})(e.url)}),`;
const LAZY = 'loading:"lazy",decoding:"async",';
const IMG = 'className:"object-cover w-full h-full group-hover:scale-105 transition-transform duration-';
const BOX = '(0,a.jsx)("div",{className:"relative w-80 h-full overflow-hidden rounded-2xl flex-shrink-0",children:(0,a.jsx)("img",{';
const TEXT = '(0,a.jsxs)("div",{className:"flex flex-col justify-center flex-1 py-4",children:[';

// [name, text before the insert point, text after it, the insert]. The text after it is part of `from`, so `to` never
// contains its `from` (a second run could not insert twice).
const SRC = 'src:new URL(e.thumbnail)';
const edits = [
  ['card picture is lazy', `${IMG}300",`, SRC, LAZY],
  ['card names its outlet', '(0,a.jsxs)("div",{className:"p-4",children:[', '(0,a.jsx)("h3"', OUTLET],
  ['row (picture left) picture is lazy', `children:l?(0,a.jsxs)(a.Fragment,{children:[${BOX}${IMG}500",`, SRC, LAZY],
  ['row (picture left) names its outlet', `alt:e.title})}),${TEXT}`, '(0,a.jsx)("h2"', OUTLET],
  ['row (picture right) picture is lazy', `children:e.content})]}),${BOX}${IMG}500",`, SRC, LAZY],
  ['row (picture right) names its outlet', `}):(0,a.jsxs)(a.Fragment,{children:[${TEXT}`, '(0,a.jsx)("h2"', OUTLET],
];

// The outlet line is small and quiet in both themes (opacity, not a colour). A focused card already gets patch-colors'
// ring (checked live: 2px terracotta), so this adds none.
const DISCOVER_CARDS = `/*fane:discover-cards*/
[data-fane-outlet]{margin:0 0 .4rem;font-size:12px;line-height:1.3;letter-spacing:.02em;opacity:.6}`;

const TARGETS = [
  ...edits.map(([name, before, after, insert]) => ({ name, file: FILES.discoverClient, from: before + after, to: before + insert + after })),
  { name: 'outlet line style', file: FILES.appCss, from: END, to: `${END}\n${DISCOVER_CARDS}\n`, marker: '/*fane:discover-cards*/' },
];

module.exports = { TARGETS, HOST, DISCOVER_CARDS };
if (require.main === module) run('patch-discover-cards', TARGETS);
