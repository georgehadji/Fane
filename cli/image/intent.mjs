// Prompt intent -> { family, tier }. Strategy chain like reasoner's ImageModelSelector:
// a cheap text model classifies when available, and the keyword rules answer when it is
// not (no key, no credits, bad JSON). The tier is always best value (DEFAULT_TIER) unless
// --tier says otherwise: "highly detailed" in a prompt is not a reason to pay 10x per image.
// An explicit --family / --tier always wins.
import { ASPECT_RATIOS, DEFAULT_TIER, FAMILIES } from './catalogue.mjs';

const RULES = [
  ['vector', /\b(svg|vector|logo|icon|line[- ]?art|monogram|emblem)\b/i],
  ['text_in_image', /\b(poster|typograph\w*|lettering|sign(?:age)?|banner|label|infographic|menu|title card|headline|caption|book cover|text that reads)\b|["“][^"”]{2,}["”]/i],
  ['design', /\b(illustration|flat design|ui|mockup|branding|pattern|sticker|isometric|packaging|wallpaper)\b/i],
  ['photoreal', /\b(photo\w*|realistic|photoreal\w*|portrait|cinematic|dslr|35mm|bokeh|hdr|product shot)\b/i],
];

// "create an image of ...", "draw me a logo for ...": a request for a picture, not a question.
// Vane's answer pipeline can only write text, so the CLI sends these to the image pipeline.
const IMAGE_REQUEST = /^\s*(?:please\s+|can you\s+|could you\s+)*(?:create|generate|make|draw|paint|render|design|produce|illustrate)\s+(?:me\s+|us\s+)?(?:(?:an?|some|\d+|one|two|three|four|five|six|seven|eight)\s+)?(?:(?:new|different|separate|wide|widescreen|landscape|portrait|tall|vertical|square|detailed|realistic|beautiful|high[- ]res(?:olution)?)\s+){0,2}(?:image|picture|pic|photo(?:graph)?|illustration|drawing|painting|sketch|logo|icon|poster|wallpaper|artwork|render(?:ing)?|portrait|cartoon)s?\b/i;
// Drawing verbs need no noun ("draw a fox"), except figures of speech ("draw a conclusion").
const DRAW_REQUEST = /^\s*(?:please\s+|can you\s+|could you\s+)*(?:draw|paint|sketch|illustrate)\s+(?:me\s+|us\s+)?(?:an?|the|some|\d+|my|our)\s+(?!(?:conclusions?|comparisons?|distinctions?|parallels?|lines? between|picture of (?:the|how|why|what))\b)/i;
export const isImageRequest = (text) => IMAGE_REQUEST.test(String(text || '')) || DRAW_REQUEST.test(String(text || ''));
// The subject without the request words, for file names: "create an image of a fox" -> "a fox".
export const imageSubject = (text) => String(text || '').replace(IMAGE_REQUEST, '').replace(/^\s*(?:please\s+|can you\s+|could you\s+)*(?:draw|paint|sketch|illustrate)\s+(?:me\s+|us\s+)?/i, '').replace(/^\s*(?:of|showing|with|for|that shows)\s+/i, '').trim() || String(text || '');

export function classifyByRules(prompt, { hasReference = false } = {}) {
  const family = hasReference ? 'reference_edit' : (RULES.find(([, re]) => re.test(prompt))?.[0] || 'general');
  return { family, tier: DEFAULT_TIER, source: 'rules' };
}

const SYSTEM = `Classify an image-generation prompt. Reply with JSON only:
{"family": one of ${JSON.stringify(FAMILIES.filter(f => f !== 'reference_edit'))}}
vector = SVG/logo/icon/line art; text_in_image = the image must contain legible words (posters, signs, infographics);
design = illustration, UI, patterns, branding; photoreal = photographs or realistic scenes; general = anything else.`;

// Parse the model's reply; anything unusable returns null so the rules decide.
export function parseClassification(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const family = String(j.family || '').toLowerCase().trim();
    if (!FAMILIES.includes(family)) return null;
    return { family, tier: DEFAULT_TIER, source: 'model' };
  } catch {
    return null;
  }
}

// complete(system, user) -> Promise<string>; omit it to use the rules only.
export async function classifyIntent(prompt, { complete, hasReference = false, family, tier } = {}) {
  let picked = null;
  if (hasReference) picked = { family: 'reference_edit', tier: DEFAULT_TIER, source: 'reference' };
  else if (complete && !family) {
    try { picked = parseClassification(await complete(SYSTEM, prompt)); } catch { /* fall through to rules */ }
  }
  picked ||= classifyByRules(prompt, { hasReference });
  return { ...picked, family: family || picked.family, tier: tier || picked.tier };
}

// Count and shape asked for in the prompt itself: "make 2 images of ...", "a 16:9 picture",
// "a wide image", "widescreen". Only unambiguous forms count ("wide shot", "a square table"
// and "3 cats" are about the scene). An explicit --count / --aspect wins over these words.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
// The adjective list repeats IMAGE_REQUEST's, which decides whether this is an image request at all.
const COUNT = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight)\s+(?:(?:new|different|separate|wide|widescreen|landscape|portrait|tall|vertical|square|detailed|realistic|beautiful|high[- ]res(?:olution)?)\s+){0,2}(?:images?|pictures?|photos?|variations?|versions?)\b/i;
const RATIO = /\b(\d{1,2}):(\d{1,2})\b/;
const SHAPE = /\b(wide|landscape|portrait|tall|vertical|square)[\s-]+(?:format|orientation|aspect|images?|pictures?|photos?|versions?)\b|\b(widescreen)\b/i;
const SHAPE_RATIO = { wide: '16:9', widescreen: '16:9', landscape: '4:3', portrait: '3:4', tall: '9:16', vertical: '9:16', square: '1:1' };

export function parseImageOptions(text) {
  const t = String(text || '');
  const out = {};
  const c = COUNT.exec(t)?.[1];
  if (c) out.count = Number(c) || NUMBER_WORDS[c.toLowerCase()];
  const r = RATIO.exec(t);
  const word = SHAPE.exec(t);
  const aspect = r && ASPECT_RATIOS.includes(r[0]) ? r[0] : word ? SHAPE_RATIO[(word[1] || word[2]).toLowerCase()] : null;
  if (aspect) out.aspect = aspect;
  return out;
}

// A follow-up that changes the images of the previous answer: "make it a watercolour", "now at
// night", "add a hat", "in the style of ...". The caller only asks this when the previous
// answer was Fane's images, so the words may be short. Questions are not edits.
const EDIT_START = /^\s*(?:(?:ok(?:ay)?|now|and|but|then|please|can you|could you)[,.]?\s+)*(?:make|turn|change|add|remove|replace|redo|recolou?r|restyle|try|give|put|keep|use|same|again|more|less|in|at|as|during|under|with|without|but)\b/i;
const QUESTION_START = /^\s*(?:what|why|how|who|when|where|which|is|are|does|do|did|explain|tell|describe)\b/i;
export const isImageEdit = (text) => EDIT_START.test(String(text || '')) && !QUESTION_START.test(String(text || ''));

// Which of the earlier images an edit means: "the second one", "image 3", "#2"; the first by default.
const ORDINALS = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3 };
export function pickReferenceIndex(text, count) {
  const t = String(text || '').toLowerCase();
  const word = t.split(/\W+/).find(w => Object.hasOwn(ORDINALS, w));
  const n = word !== undefined ? ORDINALS[word] : /(?:image|picture|number|#)\s*(\d)\b/.exec(t)?.[1] - 1;
  return Number.isInteger(n) && n >= 0 && n < count ? n : 0;
}
