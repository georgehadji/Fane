// Vane: a warm palette with one terracotta accent, colors that pass WCAG contrast, and quiet icons.
// Measured on the pinned build (text 4.5:1, icons and focus rings 3:1):
//  - keyboard focus was invisible (`focus:outline-none` everywhere, no ring instead);
//  - light theme: the selected mode icon (#ff9800, 2.0:1), the active source icon (#0ea5e9, 2.6:1), the delete
//    icon (#f87171, 2.8:1) and the half-black secondary text (source site names, "1 day ago": 3.9:1);
//  - links had the color of the text around them, in both themes;
//  - six accent hues meant six things (orange mode icon, sky-blue model icon and send button, cyan hover in Discover,
//    teal selected tab, #24a0ed follow-up send, blue links), and the neutrals were GitHub's cool greys (#0d1117 ...).
// Version 2 is one accent for everything that is selected, clickable, hovered or focused: terracotta #9e4420 on light
// (5.7:1 on the page, 5.2:1 on cards; #b4532a behind white text, 5.0:1, as in the filled Discover tab) and #e0805a on
// dark (6.7:1). It also marks the active sidebar item and the phone bar's current page. The neutrals are warm, paper
// on light (#f7f2ea page, #efe8dc cards, #e2d8c7 lines) and a deep charcoal on dark with lifted cards (#110f0b page,
// #1f1b14 cards, #322c22 lines); text #ede6da and #a39a8c on dark, #3d362e and #5c5246 on light. Red stays for errors and delete; the bin in the chat
// header is grey until hovered. The "Research begins here." heading is full ink (it was 70% black, like disabled text).
// One block appended to the end of Vane's stylesheet, so it wins on order without editing the minified rules.
// The stylesheet is served with max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');


// Light-only rules use html:not(.dark): next-themes puts "dark" or "light" on <html>.
// The focus ring needs !important, because Vane's `focus:outline-none` and `focus-visible:outline-none` set a
// transparent outline on most controls. The textarea keeps its own caret and box as the focus sign.
// The first version, as a stylesheet patched before the warm palette holds it.
const COLORS_V1 = String.raw`/*fane:colors*/
:focus-visible:not(textarea){outline:2px solid #2563eb!important;outline-offset:2px!important}
.dark :focus-visible:not(textarea){outline-color:#58a6ff!important}
html:not(.dark) .text-\[\#FF9800\]{color:#b45309}
html:not(.dark) .text-sky-500{color:#0369a1}
html:not(.dark) .text-red-400{color:#dc2626}
html:not(.dark) .text-black\/50{color:#475569}
.dark\:text-white\/50:is(.dark *){color:#8b949e}
.dark\:text-white:is(.dark *){color:#e6edf3}
.prose{--tw-prose-links:#1d4ed8;--tw-prose-invert-links:#58a6ff;--tw-prose-invert-headings:#e6edf3;--tw-prose-invert-bold:#e6edf3}`;

// Vane's neutral tokens (light-primary/secondary/100/200, dark-primary/secondary/100/200), each rule of the pinned
// stylesheet that uses one, with the warm value: same selectors, so they win on order.
const NEUTRALS = String.raw`.border-light-200{border-color:rgb(226 216 199/var(--tw-border-opacity,1))}
.border-light-200\/20{border-color:rgb(226 216 199/.2)}
.border-light-200\/50{border-color:rgb(226 216 199/.5)}
.border-light-200\/60{border-color:rgb(226 216 199/.6)}
.border-light-secondary{border-color:rgb(239 232 220/var(--tw-border-opacity,1))}
.bg-dark-200{background-color:rgb(50 44 34/var(--tw-bg-opacity,1))}
.bg-light-100{background-color:rgb(239 232 220/var(--tw-bg-opacity,1))}
.bg-light-100\/50{background-color:rgb(239 232 220/.5)}
.bg-light-200{background-color:rgb(226 216 199/var(--tw-bg-opacity,1))}
.bg-light-200\/40{background-color:rgb(226 216 199/.4)}
.bg-light-primary{background-color:rgb(247 242 234/var(--tw-bg-opacity,1))}
.bg-light-primary\/80{background-color:rgb(247 242 234/.8)}
.bg-light-primary\/95{background-color:rgb(247 242 234/.95)}
.bg-light-secondary{background-color:rgb(239 232 220/var(--tw-bg-opacity,1))}
.bg-light-secondary\/10{background-color:rgb(239 232 220/.1)}
.bg-light-secondary\/20{background-color:rgb(239 232 220/.2)}
.bg-light-secondary\/30{background-color:rgb(239 232 220/.3)}
.bg-light-secondary\/50{background-color:rgb(239 232 220/.5)}
.text-light-200{color:rgb(226 216 199/var(--tw-text-opacity,1))}
.shadow-light-200\/10{--tw-shadow-color:rgb(226 216 199/0.1)}
.hover\:bg-dark-100:hover{background-color:rgb(31 27 20/var(--tw-bg-opacity,1))}
.hover\:bg-light-100:hover{background-color:rgb(239 232 220/var(--tw-bg-opacity,1))}
.hover\:bg-light-200:hover{background-color:rgb(226 216 199/var(--tw-bg-opacity,1))}
.hover\:bg-light-secondary:hover{background-color:rgb(239 232 220/var(--tw-bg-opacity,1))}
.disabled\:bg-light-200:disabled{background-color:rgb(226 216 199/var(--tw-bg-opacity,1))}
.dark\:border-dark-200:is(.dark *){border-color:rgb(50 44 34/var(--tw-border-opacity,1))}
.dark\:border-dark-200\/20:is(.dark *){border-color:rgb(50 44 34/.2)}
.dark\:border-dark-200\/30:is(.dark *){border-color:rgb(50 44 34/.3)}
.dark\:border-dark-200\/50:is(.dark *){border-color:rgb(50 44 34/.5)}
.dark\:border-dark-200\/60:is(.dark *){border-color:rgb(50 44 34/.6)}
.dark\:border-dark-secondary:is(.dark *){border-color:rgb(31 27 20/var(--tw-border-opacity,1))}
.dark\:bg-dark-100:is(.dark *){background-color:rgb(31 27 20/var(--tw-bg-opacity,1))}
.dark\:bg-dark-100\/50:is(.dark *){background-color:rgb(31 27 20/.5)}
.dark\:bg-dark-200:is(.dark *){background-color:rgb(50 44 34/var(--tw-bg-opacity,1))}
.dark\:bg-dark-200\/40:is(.dark *){background-color:rgb(50 44 34/.4)}
.dark\:bg-dark-primary:is(.dark *){background-color:rgb(17 15 11/var(--tw-bg-opacity,1))}
.dark\:bg-dark-primary\/80:is(.dark *){background-color:rgb(17 15 11/.8)}
.dark\:bg-dark-primary\/95:is(.dark *){background-color:rgb(17 15 11/.95)}
.dark\:bg-dark-secondary:is(.dark *){background-color:rgb(31 27 20/var(--tw-bg-opacity,1))}
.dark\:bg-dark-secondary\/10:is(.dark *){background-color:rgb(31 27 20/.1)}
.dark\:bg-dark-secondary\/20:is(.dark *){background-color:rgb(31 27 20/.2)}
.dark\:bg-dark-secondary\/30:is(.dark *){background-color:rgb(31 27 20/.3)}
.dark\:bg-dark-secondary\/50:is(.dark *){background-color:rgb(31 27 20/.5)}
.dark\:hover\:bg-dark-200:hover:is(.dark *){background-color:rgb(50 44 34/var(--tw-bg-opacity,1))}
.dark\:hover\:bg-dark-secondary:hover:is(.dark *){background-color:rgb(31 27 20/var(--tw-bg-opacity,1))}
.hover\:dark\:bg-dark-100:is(.dark *):hover{background-color:rgb(31 27 20/var(--tw-bg-opacity,1))}
.hover\:dark\:bg-dark-200:is(.dark *):hover{background-color:rgb(50 44 34/var(--tw-bg-opacity,1))}
.hover\:dark\:bg-dark-secondary:is(.dark *):hover{background-color:rgb(31 27 20/var(--tw-bg-opacity,1))}
.dark\:disabled\:bg-dark-200:disabled:is(.dark *){background-color:rgb(50 44 34/var(--tw-bg-opacity,1))}`;

const COLORS_V2 = String.raw`/*fane:colors-2*/
${NEUTRALS}
:root.dark *,body.dark *,html.dark *{scrollbar-color:#322c22 transparent}
html.dark ::-webkit-scrollbar-thumb{background:#322c22}
html.dark ::-webkit-scrollbar-thumb:hover{background:#43392b}
html:not(.dark) .text-black\/50{color:#5c5246}
html:not(.dark) .text-red-400{color:#dc2626}
.dark\:text-white\/50:is(.dark *){color:#a39a8c}
.dark\:text-white:is(.dark *){color:#ede6da}
.prose{--tw-prose-body:#3d362e;--tw-prose-headings:#1f1a14;--tw-prose-bold:#1f1a14;--tw-prose-links:#9e4420;--tw-prose-invert-body:#ddd5c8;--tw-prose-invert-headings:#ede6da;--tw-prose-invert-bold:#ede6da;--tw-prose-invert-links:#e0805a}
:focus-visible:not(textarea){outline:2px solid #9e4420!important;outline-offset:2px!important}
.dark :focus-visible:not(textarea){outline-color:#e0805a!important}
.text-\[\#FF9800\],.text-sky-400,.text-sky-500,.text-cyan-700,.text-\[\#24A0ED\],.group:hover .group-hover\:text-cyan-500,.group:hover .group-hover\:text-sky-400,.group:hover .group-hover\:text-\[\#24A0ED\]{color:#9e4420}
.text-cyan-800{color:#8a3a1a}
.dark .text-\[\#FF9800\],.dark .text-sky-400,.dark .text-sky-500,.dark .text-\[\#24A0ED\],.dark\:text-cyan-300:is(.dark *),.group:hover .dark\:group-hover\:text-cyan-300:is(.dark *),.dark .group:hover .group-hover\:text-cyan-500,.dark .group:hover .group-hover\:text-sky-400,.dark .group:hover .group-hover\:text-\[\#24A0ED\]{color:#e0805a}
.dark\:text-cyan-50:is(.dark *){color:#fbede6}
.bg-sky-500,.bg-\[\#24A0ED\],.data-\[checked\]\:bg-sky-500[data-checked],.dark\:bg-sky-500:is(.dark *),.dark\:data-\[checked\]\:bg-sky-500[data-checked]:is(.dark *){background-color:#b4532a}
.bg-sky-500\/10{background-color:rgb(180 83 42/.1)}
.bg-sky-500\/70{background-color:rgb(180 83 42/.7)}
.dark\:bg-sky-500\/10:is(.dark *){background-color:rgb(224 128 90/.1)}
.dark\:bg-sky-500\/40:is(.dark *){background-color:rgb(224 128 90/.4)}
.bg-cyan-100{background-color:#f6e4da}
.bg-cyan-300\/20{background-color:rgb(224 128 90/.2)}
.border-sky-600{border-color:#9e4420}
.border-cyan-700\/60{border-color:rgb(158 68 32/.6)}
.dark\:border-cyan-300\/40:is(.dark *){border-color:rgb(224 128 90/.4)}
html .bg-cyan-300\/20.text-cyan-700,html.dark .bg-cyan-300\/20.text-cyan-700{background-color:#b4532a;border-color:#b4532a;color:#ffffff}
html .bg-light-200.group.rounded-lg{background-color:rgb(180 83 42/.14);color:#9e4420}
html.dark .bg-light-200.group.rounded-lg{background-color:rgb(224 128 90/.16);color:#e0805a}
html .absolute.top-0.h-1.bg-black{background-color:#b4532a}
html.dark .absolute.top-0.h-1.bg-black{background-color:#e0805a}
html button[data-fane-icon]:hover,html a[data-fane-icon]:hover{color:#9e4420}
html.dark button[data-fane-icon]:hover,html.dark a[data-fane-icon]:hover{color:#e0805a}
html [data-fane-icon]:hover svg{color:inherit}
html .bg-transparent.text-red-400{color:rgb(31 26 20/.6)}
html.dark .bg-transparent.text-red-400{color:rgb(237 230 218/.6)}
html .bg-transparent.text-red-400:hover,html .bg-transparent.text-red-400:focus-visible{color:#dc2626}
html.dark .bg-transparent.text-red-400:hover,html.dark .bg-transparent.text-red-400:focus-visible{color:#f87171}
h2.text-3xl.-mt-8{color:#1f1a14}
.dark h2.text-3xl.-mt-8{color:#ede6da}`;

// Version 3: the hover color skips a filled button. The question box's Send button is a terracotta (#b4532a) disc with a
// white arrow and is also a `data-fane-icon` button, so hovering it painted the arrow terracotta on terracotta.
const FILLED = String.raw`:not(.bg-\[\#24A0ED\]):not(.bg-sky-500)`;
const HOVER = ['html button[data-fane-icon]:hover,html a[data-fane-icon]:hover', 'html.dark button[data-fane-icon]:hover,html.dark a[data-fane-icon]:hover'];
const COLORS_V3 = HOVER.reduce((css, rule) => {
  const next = css.replace(rule, () => rule.replace(/(?:button|a)\[data-fane-icon\]/g, m => `${m}${FILLED}`));
  if (next === css) throw new Error(`patch-colors: hover rule not found: ${rule}`);
  return next;
}, COLORS_V2.replace('/*fane:colors-2*/', '/*fane:colors-3*/'));

// Version 4: <html> gets the page color. Vane gives only <main> a background, so the browser's white canvas showed
// wherever <main> did not reach: when the page is pulled past its end, and in the gap a phone's moving address bar
// leaves. Both themes, so the gap is paper on light and charcoal on dark.
// The follow-up bar of a chat also sits on a fade that Vane draws in white (light theme only, `dark:hidden`), which left a
// white band under the bar on the paper page: the same fade, in the page color.
const PAPER = '247 242 234';
const FADE = [[1, 0], [1, 35], [.95, 45], [.85, 55], [.7, 65], [.5, 75], [.3, 85], [.1, 92], [0, 100]]
  .map(([a, at]) => `${a === 1 ? '#f7f2ea' : `rgb(${PAPER}/${a})`} ${at}%`).join(',');
const CANVAS = `html{background-color:#f7f2ea}\nhtml.dark{background-color:#110f0b}\nhtml:not(.dark) .pointer-events-none.absolute.-bottom-6.left-0.right-0{background-image:linear-gradient(to top,${FADE})!important}`; // Vane sets it in an inline style
const COLORS = `${COLORS_V3.replace('/*fane:colors-3*/', '/*fane:colors-4*/')}\n${CANVAS}`;

const TARGETS = [
  {
    name: 'warm palette, one accent, accessible colors',
    file: FILES.appCss,
    // an earlier version's block is replaced where it stands (other blocks may sit between it and the end)
    alts: [{ from: COLORS_V3, to: COLORS }, { from: COLORS_V2, to: COLORS }, { from: COLORS_V1, to: COLORS }, { from: END, to: `${END}
${COLORS}
` }],
    marker: '/*fane:colors-4*/',
  },
];

module.exports = { TARGETS, COLORS, COLORS_V1, COLORS_V2, COLORS_V3 };
if (require.main === module) run('patch-colors', TARGETS);
