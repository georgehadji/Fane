// Vane: signal-bar icons in the answer-mode menu, and the accent only for the mode in use.
// The menu (Speed, Balanced, Quality) drew its icons in three Material colors, #ff9800 orange, #4caf50 green and
// #2196f3 blue, and the Quality star alone was filled, so the colors said nothing and the set looked borrowed. Quality
// also carried a sky-blue "Beta" pill. Now the icons are signal bars (one, two, three) in the text's grey, the selected mode's icon and the
// one on the question box's button take the accent of patch-colors (terracotta), the selected row gets a 2px accent
// edge and aria-pressed (it was marked by a background tint only), and Quality has no "Beta" tag.
// A browser chunk and the stylesheet, served with max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');

const ICONS = [
  ['speed', '(0,r.jsx)(eU.A,{size:16,className:"text-[#FF9800]"})'],
  ['balanced', '(0,r.jsx)(eO.A,{size:16,className:"text-[#4CAF50]"})'],
  ['quality', '(0,r.jsx)(eq.A,{size:16,className:"text-[#2196F3] dark:text-[#BBDEFB] fill-[#BBDEFB] dark:fill-[#2196F3]"})'],
];
// Quality's "Beta" tag, as Vane ships it and as the first version of this patch left it (a quiet outlined tag).
// patch-quality-mode fixed Quality, and it was the most accurate mode on all six questions of scripts/bench.mjs.
const BETA_TAGS = [
  'className:"bg-sky-500/70 dark:bg-sky-500/40 border border-sky-600 px-1 rounded-full text-[10px] text-white"',
  'className:"fane-badge rounded-full text-[10px]"',
].map(c => `,"quality"===a.key&&(0,r.jsx)("span",{${c},children:"Beta"})`);
// `e` is the mode in use, `a` the row's mode.
const ROW = '(0,r.jsxs)(h.ut,{onClick:()=>t(a.key),className:(0,o.cn)("p-2 rounded-lg flex flex-col items-start justify-start text-start space-y-1 duration-200 cursor-pointer transition focus:outline-none",e===a.key?"bg-light-secondary dark:bg-dark-secondary":';

// Grey icons pass 3:1 on both themes (4.1:1 light, 5.5:1 dark); the accent is patch-colors' #9e4420 / #e0805a.
const STYLE = String.raw`/*fane:mode-icons*/
.fane-mode-icon{color:rgb(31 26 20/.55)}
.dark .fane-mode-icon{color:rgb(237 230 218/.6)}
.fane-mode-on .fane-mode-icon,[aria-label="Answer mode"] .fane-mode-icon{color:#9e4420}
.dark .fane-mode-on .fane-mode-icon,.dark [aria-label="Answer mode"] .fane-mode-icon{color:#e0805a}
.fane-mode-on{box-shadow:inset 2px 0 0 #b4532a}
.dark .fane-mode-on{box-shadow:inset 2px 0 0 #e0805a}`;

// Signal bars instead of Vane's bolt, sliders and star: one, two or three of three bars filled, the rest faint, so the
// depth of research reads at a glance and the three icons are one drawing.
const bars = (filled) => '(0,r.jsxs)("svg",{width:16,height:16,viewBox:"0 0 16 16",fill:"currentColor",className:"fane-mode-icon","aria-hidden":!0,children:['
  + [[2, 9, 5], [6.5, 5, 9], [11, 1, 13]]
    .map(([x, y, h], i) => `(0,r.jsx)("rect",{x:${x},y:${y},width:3,height:${h},rx:1${i < filled ? '' : ',fillOpacity:.3'}})`)
    .join(',')
  + ']})';

const TARGETS = [
  ...ICONS.map(([mode, from], i) => ({
    name: `${mode} icon as ${i + 1} signal bar${i ? 's' : ''}`,
    file: FILES.messageClient,
    from,
    to: bars(i + 1),
  })),
  { name: 'no Beta tag', file: FILES.messageClient, alts: BETA_TAGS.map(from => ({ from, to: '/*fane:no-beta*/' })) },
  {
    name: 'selected mode marked',
    file: FILES.messageClient,
    from: ROW,
    to: ROW.replace('(h.ut,{onClick', '(h.ut,{"aria-pressed":e===a.key,onClick').replace('"bg-light-secondary dark:bg-dark-secondary":', '"bg-light-secondary dark:bg-dark-secondary fane-mode-on":'),
  },
  { name: 'mode icon colors', file: FILES.appCss, from: END, to: `${END}\n${STYLE}\n`, marker: '/*fane:mode-icons*/' },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-mode-icons', TARGETS);
