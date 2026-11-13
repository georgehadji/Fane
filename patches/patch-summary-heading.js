// Vane: the heading of a summary chat shows the article's title, not its address.
// patch-discover-summary-greek opens chats whose question is "Περίληψη: <title>\n<address>". The chat heading prints the
// whole question, so it showed a long address under the word «Περίληψη». The heading now prints only the first line;
// the question itself, address included, is unchanged, so the researcher still reads the page. A question that is
// not of that shape (including the old "Περίληψη: <address>" with no title) is printed as it is.
// A browser chunk (FILES.messageClient), served with max-age=0, so a normal reload picks it up. Runs after
// patch-greek-lang (file order), whose `lang` prop is already in front of `children:`; that patch carries a marker
// for this reason.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

// Injected as source text: no imports, no closure, ASCII (the word «Περίληψη» is built from its char codes).
function HEAD(q) {
  var w = String.fromCharCode(928, 949, 961, 943, 955, 951, 968, 951) + ': ';
  var s = String(q), i = s.indexOf('\n');
  if (i <= w.length || s.indexOf(w) !== 0) return q; // no first line with a title after the word
  return /^\s*https?:\/\/\S+\s*$/.test(s.slice(i + 1)) ? s.slice(0, i) : q; // the rest must be just the address
}

const FROM = '(e.message.query),children:e.message.query})';
const TARGETS = [{
  name: 'summary heading shows the title',
  file: FILES.messageClient,
  from: FROM,
  to: `(e.message.query),children:(${HEAD})(e.message.query)})`,
}];

module.exports = { TARGETS, HEAD };
if (require.main === module) run('patch-summary-heading', TARGETS);
