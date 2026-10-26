// Prompt intent -> { family, tier }. Strategy chain like reasoner's ImageModelSelector:
// a cheap text model classifies when available, and the keyword rules answer when it is
// not (no key, no credits, bad JSON). An explicit --family / --tier always wins.
import { FAMILIES, TIERS } from './catalogue.mjs';

const RULES = [
  ['vector', /\b(svg|vector|logo|icon|line[- ]?art|monogram|emblem)\b/i],
  ['text_in_image', /\b(poster|typograph\w*|lettering|sign(?:age)?|banner|label|infographic|menu|title card|headline|caption|book cover|text that reads)\b|["“][^"”]{2,}["”]/i],
  ['design', /\b(illustration|flat design|ui|mockup|branding|pattern|sticker|isometric|packaging|wallpaper)\b/i],
  ['photoreal', /\b(photo\w*|realistic|photoreal\w*|portrait|cinematic|dslr|35mm|bokeh|hdr|product shot)\b/i],
];
const PREMIUM = /\b(high[- ]quality|premium|best quality|highly detailed|4k|8k|professional|print[- ]ready|award[- ]winning)\b/i;

export function classifyByRules(prompt, { hasReference = false } = {}) {
  const family = hasReference ? 'reference_edit' : (RULES.find(([, re]) => re.test(prompt))?.[0] || 'general');
  return { family, tier: PREMIUM.test(prompt) ? 'premium' : 'budget', source: 'rules' };
}

const SYSTEM = `Classify an image-generation prompt. Reply with JSON only:
{"family": one of ${JSON.stringify(FAMILIES.filter(f => f !== 'reference_edit'))}, "tier_hint": "budget" | "premium"}
vector = SVG/logo/icon/line art; text_in_image = the image must contain legible words (posters, signs, infographics);
design = illustration, UI, patterns, branding; photoreal = photographs or realistic scenes; general = anything else.
tier_hint is premium only when the prompt asks for top quality, fine detail or print use.`;

// Parse the model's reply; anything unusable returns null so the rules decide.
export function parseClassification(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const family = String(j.family || '').toLowerCase().trim();
    const tier = String(j.tier_hint || j.tier || '').toLowerCase().trim();
    if (!FAMILIES.includes(family)) return null;
    return { family, tier: TIERS.includes(tier) ? tier : 'budget', source: 'model' };
  } catch {
    return null;
  }
}

// complete(system, user) -> Promise<string>; omit it to use the rules only.
export async function classifyIntent(prompt, { complete, hasReference = false, family, tier } = {}) {
  let picked = null;
  if (hasReference) picked = { family: 'reference_edit', tier: 'budget', source: 'reference' };
  else if (complete && !family) {
    try { picked = parseClassification(await complete(SYSTEM, prompt)); } catch { /* fall through to rules */ }
  }
  picked ||= classifyByRules(prompt, { hasReference });
  return { ...picked, family: family || picked.family, tier: tier || picked.tier };
}
