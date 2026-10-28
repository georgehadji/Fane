// Vane: a real ellipsis in the chat header's shortened title ("write a 500 word article about…", not "about...").
// The header cuts the first question at 30 characters and ended it with three periods. A browser chunk, served with
// max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const FROM = '`${b[0].message.query.substring(0,30).trim()}...`';

const TARGETS = [
  { name: 'ellipsis in the chat title', file: FILES.messageClient, from: FROM, to: FROM.replace('...`', '…`') },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-chat-title', TARGETS);
