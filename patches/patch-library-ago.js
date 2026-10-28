// Vane: "26 seconds ago" in Library, not "26 seconds Ago".
// Vane's Library writes the age of a chat as the time span followed by the text " Ago", so every row showed a capital
// in mid-phrase. A browser chunk, served with max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const FROM = '(0,l.S)(new Date,a.createdAt)," Ago"]';

const TARGETS = [
  {
    name: 'lowercase "ago" in Library',
    file: FILES.libraryClient,
    from: FROM,
    to: FROM.replace('" Ago"', '" ago"'),
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-library-ago', TARGETS);
