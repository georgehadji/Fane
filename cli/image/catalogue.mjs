// Image model catalogue: OpenRouter's image-output models, priced per image and ranked.
// Pure functions over catalogue entries (no network), ported from reasoner's
// infrastructure/llm/image_model_catalogue.py. Intent picks the family, the tier picks
// cheapest (budget) or most capable (premium), and primaries come from distinct labs.

// OpenRouter prices image models two ways: a flat `image` price per generated image
// (pure generators), or `image_output` per output-image token. 1290 tokens is a 1024px
// Gemini image; it ranks models correctly but is not billing-accurate.
export const TOKENS_PER_IMAGE = 1290;

export const FAMILIES = ['vector', 'photoreal', 'text_in_image', 'design', 'general', 'reference_edit'];
export const TIERS = ['budget', 'premium'];

// The only hand-maintained ranking: size/quality words in model ids, weakest first.
// '' is an id with none of them (a plain full-size model). "preview" loses to its stable twin.
const TIER_WORDS = ['preview', 'klein', 'nano', 'mini', 'lite', 'turbo', 'fast', 'flash', 'flex', 'medium', '', 'large', 'quality', 'pro', 'max'];
const PLAIN_RANK = TIER_WORDS.indexOf('');

const num = (v) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : null;
};

export function pricePerImage(pricing = {}) {
  const prompt = num(pricing.prompt);
  const flat = num(pricing.image);
  if (prompt !== null && prompt < 0) return null; // router entries ("auto") have no real price
  if (flat && !prompt) return flat; // pure generator: flat field is USD per image
  const tokenRate = num(pricing.image_output);
  if (tokenRate) return tokenRate * TOKENS_PER_IMAGE;
  return flat || null; // on hybrid chat models `image` is the input-image price, so last resort
}

export function familiesFor(id, acceptsImageInput) {
  const s = id.toLowerCase();
  const tags = new Set(['general']);
  if (s.includes('vector')) tags.add('vector').add('design');
  if (/recraft|riverflow/.test(s)) tags.add('design');
  if (/recraft|^openai\//.test(s)) tags.add('text_in_image'); // reliable in-image text renderers
  if (/flux|seedream|krea|grok|qwen|gemini|mai-image|muse|hy-image/.test(s)) tags.add('photoreal');
  if (acceptsImageInput) tags.add('reference_edit');
  return tags;
}

export const emitsSvg = (m) => m.id.endsWith('-vector');

// One catalogue entry -> model info, or null when it cannot generate images or is unpriced.
export function toModelInfo(entry) {
  const arch = entry?.architecture || {};
  const outputs = arch.output_modalities || [];
  if (!outputs.includes('image')) return null;
  const price = pricePerImage(entry.pricing);
  if (price === null) return null;
  const acceptsImageInput = (arch.input_modalities || []).includes('image');
  return {
    id: entry.id,
    name: entry.name || entry.id,
    lab: entry.id.split('/')[0],
    families: familiesFor(entry.id, acceptsImageInput),
    price,
    acceptsImageInput,
    // Pure generators answer only with an image; hybrids (Gemini, GPT) also send text.
    modalities: outputs.includes('text') ? ['image', 'text'] : ['image'],
  };
}

export const buildCatalogue = (entries) => (entries || []).map(toModelInfo).filter(Boolean);

// [tier-word rank, highest version number, price]: higher is more capable; price breaks ties.
export function capability(m) {
  const s = m.id.toLowerCase();
  const tokens = new Set(s.match(/[a-z]+/g) || []); // whole words: "mini" must not match "gemini"
  const ranks = TIER_WORDS.map((w, i) => (w && tokens.has(w) ? i : -1)).filter(i => i >= 0);
  const versions = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  return [ranks.length ? Math.min(...ranks) : PLAIN_RANK, versions.length ? Math.max(...versions) : 0, m.price];
}

const byCapabilityDesc = (a, b) => {
  const x = capability(a), y = capability(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
};

// Family members, cheapest first (budget) or most capable first (premium). SVG models are
// the only members of "vector" and never appear in any other family: an SVG answer to a
// photo prompt is broken, not cheaper.
export function candidates(catalogue, family, tier, needsReference) {
  const wantSvg = family === 'vector';
  const pool = catalogue
    .filter(m => m.families.has(family) && emitsSvg(m) === wantSvg && (m.acceptsImageInput || !needsReference))
    .sort((a, b) => a.id.localeCompare(b.id)); // deterministic ties
  return tier === 'premium' ? pool.sort(byCapabilityDesc) : pool.sort((a, b) => a.price - b.price);
}

function take(pool, count, picked, labs, allowRepeatLab = false) {
  for (const m of pool) {
    if (picked.length >= count) return;
    if (picked.some(p => p.id === m.id) || (labs.has(m.lab) && !allowRepeatLab)) continue;
    picked.push(m);
    labs.add(m.lab);
  }
}

// `count` primaries from distinct labs where possible, plus >= 4 fallbacks. A lab-thin
// family widens to "general" instead of doubling up. Exception: "vector" never widens
// (only SVG models qualify), so it may return fewer than `count`.
export function selectModels(catalogue, { family = 'general', tier = 'budget', count = 2, needsReference = false } = {}) {
  if (!FAMILIES.includes(family)) family = 'general';
  if (!TIERS.includes(tier)) tier = 'budget';
  const pool = candidates(catalogue, family, tier, needsReference);
  if (family === 'vector') return { primaries: pool.slice(0, count), fallbacks: pool.slice(count) };
  const wider = family === 'general' ? pool : candidates(catalogue, 'general', tier, needsReference);
  const primaries = [];
  const labs = new Set();
  take(pool, count, primaries, labs);
  take(wider, count, primaries, labs);
  take(pool, count, primaries, labs, true);
  take(wider, count, primaries, labs, true);
  const used = new Set(primaries.map(m => m.id));
  const fallbacks = [...pool, ...wider].filter((m, i, all) => !used.has(m.id) && all.findIndex(x => x.id === m.id) === i);
  return { primaries, fallbacks: fallbacks.slice(0, Math.max(4, count)) };
}
