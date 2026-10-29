// searxng/settings.yml as it is installed in the container (scripts/apply.mjs). The secret_key line gets a
// random value per install, and each keyed engine (KEYED_ENGINES) gets its API key and is switched on when one is
// given, so neither value is ever in the repo. docker/fane-entrypoint.sh does the same with sed: they are
// two layers, so a change here goes there too.

// The key line itself, not its placeholder value, so the repo file is the only place that says what it is.
export const SECRET_KEY_LINE = /^(\s*secret_key:).*$/m;
// API keys are letters and digits; anything else could break the YAML line or the sed in the entrypoint.
export const CORE_KEY_PATTERN = /^[A-Za-z0-9._-]{8,200}$/;

// The field that holds the key, inside an engine block that ends with `inactive:`.
const block = (name, field) => new RegExp(`(- name: ${name}\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+${field}:)[^\\n]*\\n([ \\t]+inactive:)[^\\n]*`);

// opt: the renderSettings option; env: the variable the installers read; value: what goes in the field.
export const KEYED_ENGINES = [
  { opt: 'braveKey', env: 'BRAVE_API_KEY', label: 'Brave', name: 'brave api', re: block('brave api', 'X-Subscription-Token'), value: (k) => k },
  { opt: 'tavilyKey', env: 'TAVILY_API_KEY', label: 'Tavily', name: 'tavily', re: block('tavily', 'Authorization'), value: (k) => `Bearer ${k}` },
  { opt: 'coreKey', env: 'CORE_API_KEY', label: 'CORE', name: 'core.ac.uk', re: block('core\\.ac\\.uk', 'api_key'), value: (k) => k },
];

export function renderSettings(text, { secretKey, ...keys } = {}) {
  let out = text.replace(/\r\n/g, '\n');
  if (secretKey) out = out.replace(SECRET_KEY_LINE, (_, k) => `${k} '${secretKey}'`);
  for (const e of KEYED_ENGINES) {
    const key = keys[e.opt];
    if (!key) continue;
    if (!CORE_KEY_PATTERN.test(key)) throw new Error(`${e.env} has unexpected characters (expected letters, digits, ".", "_" or "-")`);
    if (!e.re.test(out)) throw new Error(`searxng/settings.yml has no ${e.name} engine block to put the key in`);
    out = out.replace(e.re, (_, field, inactive) => `${field} '${e.value(key)}'\n${inactive} false`);
  }
  return out;
}
