// Vane: lang="el" on a Greek question and answer.
// Vane's page says lang="en" everywhere, so a screen reader read Greek answers with an English voice, and the browser
// hyphenated and chose quotes for English. The message component now marks the question heading and the answer body
// "el" when their text has more Greek letters than Latin ones; anything else keeps the page's "en". A browser chunk,
// served with max-age=0, so a normal reload picks the change up.
const { run } = require('./lib/apply-targets');
const { FILES, LANG } = require('./lib/vane');

// `e.message.query` is the question; `h` is the answer text, the children of Vane's Markdown component, which passes
// its other props to the element it renders.
const QUESTION = '"text-black dark:text-white font-medium text-3xl lg:w-9/12",children:e.message.query})';
const ANSWER = 'citation:{component:ee}}},children:h})';

const TARGETS = [
  {
    name: 'Greek question marked lang="el"',
    file: FILES.messageClient,
    from: QUESTION,
    to: QUESTION.replace('children:', `lang:(${LANG})(e.message.query),children:`),
  },
  {
    name: 'Greek answer marked lang="el"',
    file: FILES.messageClient,
    from: ANSWER,
    to: ANSWER.replace('children:h', `lang:(${LANG})(h),children:h`),
  },
];

module.exports = { TARGETS, LANG };
if (require.main === module) run('patch-greek-lang', TARGETS);
