// searxng/settings.yml as it is installed in the container (scripts/apply.mjs). The secret_key line gets a
// random value per install, and each keyed engine (KEYED_ENGINES) gets its API key and is switched on when one is
// given, so neither value is ever in the repo. docker/fane-entrypoint.sh does the same with sed: they are
// two layers, so a change here goes there too.

// The key line itself, not its placeholder value, so the repo file is the only place that says what it is.
export const SECRET_KEY_LINE = /^(\s*secret_key:).*$/m;
// API keys are letters and digits; anything else could break the YAML line or the sed in the entrypoint.
export const CORE_KEY_PATTERN = /^[A-Za-z0-9._-]{8,200}$/;

// opt: the renderSettings option; env: the variable the installers read; name: the engine; field: the line that gets
// prefix + key. docker/fane-entrypoint.sh has one switch_on call per entry, and a test compares them.
export const KEYED_ENGINES = [
  { opt: 'braveKey', env: 'BRAVE_API_KEY', label: 'Brave', name: 'brave api', field: 'X-Subscription-Token', prefix: '' },
  { opt: 'tavilyKey', env: 'TAVILY_API_KEY', label: 'Tavily', name: 'tavily', field: 'Authorization', prefix: 'Bearer ' },
  { opt: 'coreKey', env: 'CORE_API_KEY', label: 'CORE', name: 'core.ac.uk', field: 'api_key', prefix: '' },
];

// The field that holds the key, inside an engine block that ends with `inactive:`.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const block = (e) => new RegExp(`(- name: ${escape(e.name)}\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+${escape(e.field)}:)[^\\n]*\\n([ \\t]+inactive:)[^\\n]*`);

export function renderSettings(text, { secretKey, ...keys } = {}) {
  let out = text.replace(/\r\n/g, '\n');
  if (secretKey) out = out.replace(SECRET_KEY_LINE, (_, k) => `${k} '${secretKey}'`);
  for (const e of KEYED_ENGINES) {
    const key = keys[e.opt];
    if (!key) continue;
    if (!CORE_KEY_PATTERN.test(key)) throw new Error(`${e.env} has unexpected characters (expected letters, digits, ".", "_" or "-")`);
    const re = block(e);
    if (!re.test(out)) throw new Error(`searxng/settings.yml has no ${e.name} engine block to put the key in`);
    out = out.replace(re, (_, field, inactive) => `${field} '${e.prefix}${key}'\n${inactive} false`);
  }
  return out;
}
