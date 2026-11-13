// Vane: the "Related" questions under an answer are written in the language of the conversation.
// Vane's suggestion prompt (app/api/suggestions/route.js) has no language rule, so a Greek answer was followed by
// English questions. One sentence after its length rule, the same fix patch-answer-language makes for the writer.
// A server route: the change needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const FROM = 'Make sure the suggestions are medium in length and are informative and relevant to the conversation.';
const RULE = "Write every suggestion in the language of the user's own messages (a conversation in Greek gets Greek suggestions), even when the answer or its sources quote another language.";

const TARGETS = [{
  name: 'related questions in the language of the conversation',
  file: FILES.suggestionsRoute,
  from: FROM,
  to: `${FROM} ${RULE}`,
  marker: 'Write every suggestion in the language of the user', // `to` keeps its `from`, so a marker stops a second insert
}];

module.exports = { TARGETS, RULE };
if (require.main === module) run('patch-suggestions-language', TARGETS);
