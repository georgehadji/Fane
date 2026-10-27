// searxng/settings.yml as it is installed in the container (scripts/apply.mjs). The secret_key line gets a
// random value per install, and the core.ac.uk engine gets the CORE API key and is switched on when one is
// given, so neither value is ever in the repo. docker/fane-entrypoint.sh does the same with sed: they are
// two layers, so a change here goes there too.

// The key line itself, not its placeholder value, so the repo file is the only place that says what it is.
export const SECRET_KEY_LINE = /^(\s*secret_key:).*$/m;
// CORE keys are letters and digits; anything else could break the YAML line or the sed in the entrypoint.
export const CORE_KEY_PATTERN = /^[A-Za-z0-9._-]{8,200}$/;
const CORE_ENGINE = /(- name: core\.ac\.uk\n[ \t]+api_key:)[^\n]*\n([ \t]+inactive:)[^\n]*/;

export function renderSettings(text, { secretKey, coreKey } = {}) {
  let out = text.replace(/\r\n/g, '\n');
  if (secretKey) out = out.replace(SECRET_KEY_LINE, (_, k) => `${k} '${secretKey}'`);
  if (coreKey) {
    if (!CORE_KEY_PATTERN.test(coreKey)) throw new Error('CORE_API_KEY has unexpected characters (expected letters, digits, ".", "_" or "-")');
    if (!CORE_ENGINE.test(out)) throw new Error('searxng/settings.yml has no core.ac.uk engine block to put the key in');
    out = out.replace(CORE_ENGINE, (_, key, inactive) => `${key} '${coreKey}'\n${inactive} false`);
  }
  return out;
}
