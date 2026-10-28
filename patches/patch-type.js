// Vane: Commissioner instead of Montserrat, and calmer answer headings and spacing.
// Measured on the pinned build:
//  - Montserrat (Vane's text face) ships no Greek, so Greek answers fell back to a system sans while digits and Latin
//    words stayed in Montserrat: two typefaces in every line. Commissioner has Latin and Greek drawn together, so every
//    answer is one typeface. Commissioner: Copyright 2019 The Commissioner Project Authors
//    (github.com/kosbarts/Commissioner), SIL Open Font License 1.1 (https://scripts.sil.org/OFL); the latin, latin-ext
//    and greek subsets of the variable font, weights 300 to 700 (all Vane uses), as Google Fonts serves them
//    (patches/fonts/). Montserrat stays second in the stack for Cyrillic and Vietnamese, which these files lack.
//    Vane serves no file added after it starts, so the fonts are embedded in the stylesheet.
//    Commissioner's lowercase is shorter than Montserrat's (x-height 45 against 53 units at 100px) and Vane's sizes were
//    set for Montserrat, so size-adjust 108% keeps text from shrinking without making capitals tower.
//  - answer headings outranked the question (title 36px/800, sections 24px/800, question 30px/500);
//  - answer paragraphs had 162% line spacing and 1.25em between paragraphs; sidebar labels were 10px.
// One block appended to the end of Vane's stylesheet, like patch-colors (either order works: both anchor on its last rule).
const fs = require('fs');
const path = require('path');
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// The last rule of the stylesheet (the xl: media block); patch-colors anchors here too.
const END = String.raw`.xl\:text-8xl{font-size:6rem;line-height:1}}`;

// Ranges as Google Fonts serves each subset.
const SUBSETS = [
  ['latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
  ['latin-ext', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF'],
  ['greek', 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF'],
];
const face = ([name, range]) => {
  const data = fs.readFileSync(path.join(__dirname, 'fonts', `commissioner-${name}.woff2`)).toString('base64');
  return `@font-face{font-family:Commissioner;font-style:normal;font-weight:300 700;font-display:swap;size-adjust:108%;src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${range}}`;
};

// .__className_62a70d is Vane's next/font class on <body>; same selector, later in the file, so it wins.
// .prose h1 (0,1,1) beats Tailwind's prose rules and Vane's prose-h2:font-[800] (both 0,1,0).
const TYPE = String.raw`/*fane:type*/
/* Commissioner, Copyright 2019 The Commissioner Project Authors (github.com/kosbarts/Commissioner), SIL OFL 1.1 */
${SUBSETS.map(face).join('\n')}
.__className_62a70d{font-family:Commissioner,Montserrat,Arial,sans-serif}
.prose h1{font-size:1.75rem;font-weight:700;line-height:1.2}
.prose h2{font-size:1.25rem;font-weight:700;line-height:1.3}
.prose h3{font-size:1.0625rem;font-weight:600;line-height:1.35}
.prose p,.prose li{line-height:1.5}
.prose p{margin-top:.9em;margin-bottom:.9em}
.text-\[10px\]{font-size:.75rem;line-height:1rem}`;

const TARGETS = [
  {
    name: 'Commissioner, answer headings and spacing',
    file: FILES.appCss,
    from: END,
    to: `${END}\n${TYPE}\n`,
    marker: '/*fane:type*/',
  },
];

module.exports = { TARGETS, TYPE };
if (require.main === module) run('patch-type', TARGETS);
