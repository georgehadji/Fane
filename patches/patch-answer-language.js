// Vane: the answer is written in the language of the question.
// Vane's writer prompt says nothing about language, so the model followed its sources: "Περίληψη στα ελληνικά: <url>"
// (the Discover link, patch-discover-summary-greek) came back in English when the page was English. One rule at the top
// of its formatting instructions. A server chunk: the change needs Vane restarted.
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const FROM = '### Formatting Instructions\n    - **Structure**:';
const RULE = "- **Language**: Write the whole answer, headings included, in the language of the user's question, even when the sources are in another language. A question in Greek gets an answer in Greek.";
const TO = `### Formatting Instructions\n    ${RULE}\n    - **Structure**:`;

const TARGETS = [{ name: 'writer answers in the language of the question', file: FILES.research, from: FROM, to: TO }];

module.exports = { TARGETS };
if (require.main === module) run('patch-answer-language', TARGETS);
