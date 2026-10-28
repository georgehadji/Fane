// Vane: Greek in PP Editorial's places drawn in a condensed light serif, not Times New Roman.
// PP Editorial, the condensed light serif of Vane's page titles and large Discover headlines, has no Greek, so a Greek
// word there fell back to Times New Roman: upright, wide and regular weight next to the condensed light Latin. This
// adds a Greek-only face under the same family name, so the browser takes Greek letters from it and everything else from
// Vane's own file. The font is Noto Serif Display Light (Copyright 2016 Google Inc., SIL Open Font License 1.1,
// patches/fonts/OFL-noto-serif-display.txt), its greek subset as Google Fonts serves it, cut to a static instance at
// 65% width (fontTools varLib.instancer), the width of PP Editorial's letters. A variable face declared at 65% would
// never load: the browser matches font-stretch before unicode-range, so Vane's 100% face won for Greek too. Vane serves no file added
// after it starts, so the font is embedded. Appended to the end of Vane's stylesheet like patch-colors and patch-type.
const fs = require('fs');
const path = require('path');
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');

const GREEK = 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF';
const data = fs.readFileSync(path.join(__dirname, 'fonts', 'noto-serif-display-greek.woff2')).toString('base64');

const EDITORIAL_GREEK = `/*fane:editorial-greek*/
/* Noto Serif Display, Copyright 2016 Google Inc., SIL OFL 1.1 */
@font-face{font-family:PP Editorial;font-style:normal;font-weight:300;font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${GREEK}}`;

const TARGETS = [
  {
    name: 'Greek face for PP Editorial',
    file: FILES.appCss,
    from: END,
    to: `${END}\n${EDITORIAL_GREEK}\n`,
    marker: '/*fane:editorial-greek*/',
  },
];

module.exports = { TARGETS, EDITORIAL_GREEK };
if (require.main === module) run('patch-editorial-greek', TARGETS);
