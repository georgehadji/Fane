// Vane: colors that pass WCAG contrast, and one color for what can be clicked.
// Measured on the pinned build (text 4.5:1, icons and focus rings 3:1):
//  - keyboard focus was invisible (`focus:outline-none` everywhere, no ring instead);
//  - light theme: the selected mode icon (#ff9800, 2.0:1), the active source icon (#0ea5e9, 2.6:1), the delete
//    icon (#f87171, 2.8:1) and the half-black secondary text (source site names, "1 day ago": 3.9:1);
//  - links had the color of the text around them, in both themes;
//  - dark theme: pure white text (#fff, 18.9:1) glares on #0d1117; GitHub's #e6edf3 (16.0:1) matches the theme's
//    greys, as does #8b949e for secondary text (5.6:1 on cards, 6.2:1 on the page).
// One block appended to the end of Vane's stylesheet, so it wins on order without editing the minified rules.
// The stylesheet is served with max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// The last rule of the stylesheet (the xl: media block).
const END = String.raw`.xl\:text-8xl{font-size:6rem;line-height:1}}`;

// Light-only rules use html:not(.dark): next-themes puts "dark" or "light" on <html>.
// The focus ring needs !important, because Vane's `focus:outline-none` and `focus-visible:outline-none` set a
// transparent outline on most controls. The textarea keeps its own caret and box as the focus sign.
const COLORS = String.raw`/*fane:colors*/
:focus-visible:not(textarea){outline:2px solid #2563eb!important;outline-offset:2px!important}
.dark :focus-visible:not(textarea){outline-color:#58a6ff!important}
html:not(.dark) .text-\[\#FF9800\]{color:#b45309}
html:not(.dark) .text-sky-500{color:#0369a1}
html:not(.dark) .text-red-400{color:#dc2626}
html:not(.dark) .text-black\/50{color:#475569}
.dark\:text-white\/50:is(.dark *){color:#8b949e}
.dark\:text-white:is(.dark *){color:#e6edf3}
.prose{--tw-prose-links:#1d4ed8;--tw-prose-invert-links:#58a6ff;--tw-prose-invert-headings:#e6edf3;--tw-prose-invert-bold:#e6edf3}`;

const TARGETS = [
  {
    name: 'accessible colors and a link color',
    file: FILES.appCss,
    from: END,
    to: `${END}\n${COLORS}\n`,
    marker: '/*fane:colors*/',
  },
];

module.exports = { TARGETS, COLORS };
if (require.main === module) run('patch-colors', TARGETS);
