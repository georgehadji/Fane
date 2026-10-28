// Which phases a coding run has on each Vane mode, and how many tokens each role may use.
// After reasoner's CodingFlow (src/reasoner/application/flows/coding.py): library research, spec, one generation
// call per file, CVE search, adversarial review, fixes, tests. Model calls per run: spec 1, generate 1 per file
// (at most MAX_FILES), review 1, fix 1 per file with a critical or high finding or a syntax error, tests 1.
//   speed:    spec, generate
//   balanced: docs research, spec, generate, review, fix, tests
//   quality:  + a search for known vulnerabilities of the stack, given to the review
import { DEFAULT_TEXT_MODEL } from '../image/generate.mjs';
import { THINKING_HEADROOM } from '../write/models.mjs';

export const CODE_ROLES = ['spec', 'generate', 'review', 'fix', 'tests'];
export const CODE_JSON_ROLES = new Set(['spec', 'review']);

export const CODE_PHASES = {
  speed: ['spec', 'generate'],
  balanced: ['docs', 'spec', 'generate', 'review', 'fix', 'tests'],
  quality: ['docs', 'spec', 'generate', 'cve', 'review', 'fix', 'tests'],
};

// reasoner's limits (constants_limits.py MAX_CODING_FILES, and 4 parallel calls: 14 at once drew 429s).
export const MAX_FILES = 12;
export const CONCURRENCY = 4;

// reasoner's budgets per role (1536 cut real modules off mid-file), plus room for thinking as in the article roles.
const TOKENS = { spec: 4096, generate: 8192, review: 4096, fix: 8192, tests: 8192 };
export const codeTokensFor = (role) => (TOKENS[role] || 4096) + THINKING_HEADROOM;

// --code-model a,b,c: one chain for every role.
export const codeChainsFor = (models) => {
  const chain = models && models.length ? models : [DEFAULT_TEXT_MODEL];
  return Object.fromEntries(CODE_ROLES.map(r => [r, chain]));
};
