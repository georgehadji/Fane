// Refusal handling, ported from reasoner's image_generation.py: recognise provider
// refusals and text-only replies, and rewrite prompts that name protected characters,
// studios or franchises into original descriptions. Pure functions.

const POLICY_MARKERS = ['content policy', 'policy violation', 'moderated', 'safety', 'copyright', 'trademark', 'franchise', 'disallowed', 'not allowed', 'refused'];
const NON_IMAGE_MARKERS = ['no image in response', 'could not extract image', 'empty choices'];

const REPLACEMENTS = [
  [/\bmickey mouse\b/gi, 'an original cheerful cartoon mouse adventurer'],
  [/\bminnie mouse\b/gi, 'an original stylish cartoon mouse companion'],
  [/\bdonald duck\b/gi, 'an original spirited sailor duck'],
  [/\b(?:scrooge mcduck|uncle scrooge)\b/gi, 'an original adventurous tycoon duck'],
  [/\bgoofy\b/gi, 'an original lanky cartoon sidekick'],
  [/\bspider-?man\b/gi, 'an original agile masked hero'],
  [/\bbatman\b/gi, 'an original caped night vigilante'],
  [/\bsuperman\b/gi, 'an original caped flying hero'],
  [/\bpikachu\b/gi, 'an original small electric creature'],
  [/\bmario\b/gi, 'an original cheerful plumber hero'],
  [/\bdisney(?:'s)?\b/gi, 'classic storybook animation'],
  [/\bpixar\b/gi, 'stylized cinematic animation'],
  [/\bdreamworks\b/gi, 'bold family-adventure animation'],
  [/\bmarvel\b/gi, 'original superhero adventure'],
  [/\bstar wars\b/gi, 'an original space-opera world'],
  [/\bpok[eé]mon\b/gi, 'original creature companions'],
  [/\bharry potter\b/gi, 'an original magical academy adventure'],
  [/\blord of the rings\b/gi, 'an original mythic fantasy realm'],
  [/\bstudio ghibli\b/gi, 'gentle hand-painted animation'],
];
const RISK_TERMS = /\b(mickey mouse|minnie mouse|donald duck|scrooge mcduck|uncle scrooge|goofy|spider-?man|batman|superman|pikachu|mario|disney|pixar|dreamworks|marvel|star wars|pok[eé]mon|harry potter|lord of the rings|studio ghibli)\b/i;

const matchesAny = (error, markers) => markers.some(m => String(error).toLowerCase().includes(m));

export const isPolicyError = (error) => matchesAny(error, POLICY_MARKERS);
export const hasRiskTerms = (text) => RISK_TERMS.test(text);

// Retry with a rewritten prompt when a provider refused, or when two or more models
// answered without an image (a common silent refusal).
export function shouldRetry(errors) {
  if (!errors.length) return false;
  return errors.some(isPolicyError) || errors.filter(e => matchesAny(e, NON_IMAGE_MARKERS)).length >= 2;
}

// Local rewrite used when no model is available or the model's rewrite still names a
// protected work. Returns null when nothing changed or risk terms remain.
export function heuristicRewrite(prompt) {
  if (!prompt) return null;
  let out = prompt;
  for (const [re, rep] of REPLACEMENTS) out = out.replace(re, rep);
  out = out.replace(/\b(?:in the style of|styled like|inspired by|evoking|channeling)\s+[^,.;:]+/gi, 'in a polished original visual style');
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  if (!out || out === prompt || hasRiskTerms(out)) return null;
  return out.toLowerCase().includes('original') ? out : `Create an original, non-infringing scene with distinct characters and designs. ${out}`;
}

// Why a run failed, in words for the person reading the answer. First match wins; the raw
// provider errors stay available next to it.
const FAILURE_CAUSES = [
  { test: (e) => /\b402\b|insufficient credits|payment required/i.test(e), summary: 'Your OpenRouter account is out of credits.', next: 'Add credits at https://openrouter.ai/credits, then ask again.' },
  { test: (e) => /\b40[13]\b|invalid api key|unauthorized|no auth/i.test(e), summary: 'OpenRouter did not accept the API key.', next: "Check the OpenRouter key in Vane's Settings → Models." },
  { test: isPolicyError, summary: 'The image models refused this prompt.', next: 'Describe the subject in your own words, without brand or character names.' },
  { test: (e) => /\b429\b|\b5\d\d\b|rate.?limit|timed? ?out|no endpoints|unavailable|fetch failed|network/i.test(e), summary: 'The image models were busy or unreachable.', next: 'Try again in a minute.' },
];
export const explainFailure = (errors) => {
  const joined = errors.map(String);
  const cause = FAILURE_CAUSES.find(c => joined.some(c.test));
  return cause ? { summary: cause.summary, next: cause.next } : { summary: 'No image model returned a picture.', next: 'Try again or rephrase the request.' };
};

export const REWRITE_SYSTEM = 'You rewrite image prompts so mainstream image providers accept them. Replace copyrighted, trademarked, franchise, mascot or studio-owned characters and named artist styles with original descriptions, keeping the scene, medium, mood, composition and colours. Reply with the rewritten prompt only.';
