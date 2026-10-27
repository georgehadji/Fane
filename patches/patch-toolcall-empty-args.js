// Fix Vane bug: streamed tool-call continuation chunks with empty arguments
// crash with "Error:  is empty" (first chunk already falls back to "{}").
const { run } = require('./lib/apply-targets');
const { FILES } = require('./lib/vane');

const TARGETS = [
  {
    name: 'empty tool-call arguments',
    file: FILES.llmParse,
    from: 'return b.arguments+=a.function?.arguments||"",{...b,arguments:(0,n.parse)(b.arguments)}',
    to: 'return b.arguments+=a.function?.arguments||"",{...b,arguments:(0,n.parse)(b.arguments.trim()||"{}")}',
  },
];

module.exports = { TARGETS };
if (require.main === module) run('patch-toolcall-empty-args', TARGETS);
