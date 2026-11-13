// Vane: the page of a summary chat is built for reading a summary.
// patch-discover-summary-greek opens chats whose question is "Περίληψη: <title>\n<address>". On that page:
//  - the heading prints the first line only, the word and the article's title, and the title is a link to the article
//    (opens in a new tab, the address is its tooltip). The question itself, address included, is unchanged, so the
//    researcher still reads the page. A question that is not of that shape (including the old "Περίληψη: <address>"
//    with no title) is printed as it is.
//  - the answer comes first, above the sources and the research panels (CSS `order`), because the summary is what
//    the reader came for and the answer used to start below the fold.
//  - the "Search images / Search videos" column is left out: a page summary has no use for it.
// Browser files only (FILES.messageClient, FILES.appCss; both max-age=0), so a normal reload picks it up. Runs after
// patch-greek-lang (file order), whose `lang` prop is already in front of `children:`; that patch carries a marker for
// this reason. It also runs after patch-image-ui and edits its output; that patch carries a marker for this reason.
const { run } = require('./lib/apply-targets');
const { APP_CSS_END: END, FILES } = require('./lib/vane');

// Injected as source text: no imports, no closure, ASCII (the word «Περίληψη» is built from its char codes).
// True for a question that starts with it.
function ISSUM(q) {
  return String(q).indexOf(String.fromCharCode(928, 949, 961, 943, 955, 951, 968, 951) + ': ') === 0;
}

// What the heading prints. `r` is the bundle's jsx runtime.
function HEADING(q, r) {
  var w = String.fromCharCode(928, 949, 961, 943, 955, 951, 968, 951) + ': ';
  var s = String(q), i = s.indexOf('\n');
  if (i <= w.length || s.indexOf(w) !== 0) return q; // no first line with a title after the word
  var url = s.slice(i + 1).trim();
  if (!/^https?:\/\/\S+$/.test(url)) return q; // the rest must be just the address
  return r.jsxs(r.Fragment, {
    children: [
      s.slice(0, w.length),
      r.jsx('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url, 'data-fane-source': '', children: s.slice(w.length, i) }),
    ],
  });
}

// The first version: the title as plain text, no link. A container patched with it is upgraded in place.
const HEAD_V1 = `function HEAD(q) {
  var w = String.fromCharCode(928, 949, 961, 943, 955, 951, 968, 951) + ': ';
  var s = String(q), i = s.indexOf('\\n');
  if (i <= w.length || s.indexOf(w) !== 0) return q; // no first line with a title after the word
  return /^\\s*https?:\\/\\/\\S+\\s*$/.test(s.slice(i + 1)) ? s.slice(0, i) : q; // the rest must be just the address
}`;

const HEAD_FROM = '(e.message.query),children:e.message.query})';
const HEAD_TO = `(e.message.query),children:(${HEADING})(e.message.query,r)})`;
const HEAD_TO_V1 = `(e.message.query),children:(${HEAD_V1})(e.message.query)})`;

const COLUMN_FROM = '{ref:a,className:"flex flex-col space-y-6 w-full lg:w-9/12",children:[p.length>0&&';
const COLUMN_TO = `{ref:a,className:"flex flex-col space-y-6 w-full lg:w-9/12","data-fane-summary":(${ISSUM})(e.message.query)?"":void 0,children:[p.length>0&&`;

// The side column's own guard, as patch-image-ui leaves it.
const SIDE_FROM = '!h.includes("<!--fane:image-answer-->")&&(0,r.jsxs)("div",{className:"lg:sticky';
const SIDE_TO = `!h.includes("<!--fane:image-answer-->")&&!(${ISSUM})(e.message.query)&&(0,r.jsxs)("div",{className:"lg:sticky`;

// The container is a flex column: the answer is its last child, so `order` brings it first. space-y-6 puts its
// margin on every child after the first by DOM position, so the gap takes over.
const SUMMARY_PAGE = `/*fane:summary-page*/
[data-fane-summary]{gap:1.5rem}
[data-fane-summary]>*{margin-top:0!important;margin-bottom:0!important}
[data-fane-summary]>:last-child{order:-1}
h2 a[data-fane-source]{color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:.18em;text-decoration-color:rgba(128,128,128,.5)}
h2 a[data-fane-source]:hover,h2 a[data-fane-source]:focus-visible{text-decoration-color:currentColor}`;

const TARGETS = [
  {
    name: 'summary heading links the article title',
    file: FILES.messageClient,
    alts: [{ from: HEAD_FROM, to: HEAD_TO }, { from: HEAD_TO_V1, to: HEAD_TO }],
    ladder: ['fresh', 'V1'],
  },
  {
    name: 'summary column is flagged',
    file: FILES.messageClient,
    from: COLUMN_FROM,
    to: COLUMN_TO,
  },
  {
    name: 'no image/video search column beside a summary',
    file: FILES.messageClient,
    from: SIDE_FROM,
    to: SIDE_TO,
  },
  {
    name: 'summary page: answer first, heading link style',
    file: FILES.appCss,
    from: END,
    to: `${END}\n${SUMMARY_PAGE}\n`,
    marker: '/*fane:summary-page*/',
  },
];

module.exports = { TARGETS, HEADING, HEAD_V1, ISSUM, SUMMARY_PAGE };
if (require.main === module) run('patch-summary-heading', TARGETS);
