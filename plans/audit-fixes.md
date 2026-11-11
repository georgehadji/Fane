# Plan: the 24 audit fixes

Source: the whole-repo audit of 2026-10-29 (20 numbered findings plus 4 smaller ones). This plan says in what order to
fix them, how each fix fits Fane's architecture (CLAUDE.md), which design each module should use, how to test it and
how to verify it live. Nothing here is implemented yet.

## Ground rules (from CLAUDE.md, apply to every step)

- **Layers.** `core` < `image` < `write` < `code`/`brainstorm`; `cli/test/boundaries.test.mjs` fails on an upward or
  sideways import. A helper several features need goes into `core`. The CLI (`cli/*.mjs`) may import any layer.
- **Pure functions, injected dependencies, failures as values.** Pipelines and hooks get `client`, `retrieve`, `llm`,
  `fs` and `fetchImpl` injected; tests pass fakes. No new HTTP or file access inside a pure module.
- **Patches.** Exact-string targets, one engine (`patches/lib/apply-targets.js`), all or nothing, `.bak`, idempotent.
  A changed block that is already applied in a container needs an upgrade (`alts` with the old text first, new
  marker). A `to` is never a substring of its `from`. Strings several patches share live in `patches/lib/vane.js`.
- **One source of truth.** A rule written in two places is a finding (audit 10, 17, 20). Where two layers must hold the
  same rule (a patch string and an ESM module), a test compares them.
- **No new dependencies.** Fane has none; keep it that way.
- **Live container.** `scripts/apply.mjs` renders SearXNG settings from its own environment: run without
  `CORE_API_KEY` set, it switches CORE off. Either export the key first, or apply single patches and copy single
  modules by hand (`docker cp`, `node /tmp/<dir>/patch-x.js`, `docker restart vane`). Server bundles and the
  `/fane/*` modules need a restart (Node caches them); browser chunks and the stylesheet need only a reload.
- **Commits.** One commit per phase, only the phase's files, never `.claude/`; commit and push only when the user
  says so.

## Order and why

| Phase | Findings | Why here |
|---|---|---|
| 1. Patch engine | 18 | Every later phase writes patches; make the engine's all-or-nothing promise true first. |
| 2. Security | 1, 14 | A page Vane reads can reach Vane's own API (read, and possibly rewrite, the API keys). Highest cost if skipped. |
| 3. Quality answer check | 2, 3, 7, 8 | Shipped in 276c08d and corrupting or mislabelling answers now. One module, one commit. Adds `core/markdown.mjs`, which phase 4 reuses. |
| 4. Silent output corruption | 4, 5, 15, 21 | Generated code, articles and captions altered without a warning. Reuses phase 3's code-span splitter. |
| 5. Routing and consistency | 10, 11, 20 | The same rule written in several places; table-driven fixes with one source of truth. |
| 6. Pipelines and runners | 9, 12, 13, 23, 24 | Lost work and wasted calls; no shared code with earlier phases. |
| 7. Web UI | 6, 22 | Small CSS and header changes; the colors block needs an upgrade path. |
| 8. Install and CLI plumbing | 16, 17, 19 | Low risk, mostly tests. |
| 9. Docs, CI, full verification | all | README, CLAUDE.md, project page counts, benchmark, doctor. |

Numbers are the audit's. Findings 21–24 are the four smaller ones: 21 caption newlines, 22 SVG CSP, 23 trial option
validation, 24 code and brainstorm hooks skip their run log.

---

## Phase 1: patch engine

### 18. Backups written between renames (`patches/lib/apply-targets.js:69-72`)

- **Pattern: two-phase commit.** Prepare everything that can fail, then do only renames (atomic on one filesystem).
- **Change.** In `run()`, after the tmp files are written, add a loop that writes every missing `.bak`; on any error,
  remove the tmp files (and only the `.bak` files this run created) and rethrow. The last loop does only `renameSync`.
  Extend the existing comment by one line: "backups are written before any rename".
- **Test** (`cli/test/patches.test.mjs`, next to "run: a write that fails leaves every bundle as it was"): two files,
  a fake `fs` whose `writeFileSync` throws on the second `.bak` → both bundles unchanged, no tmp file left. If `run()`
  uses the module's `fs`, give it an optional `fs` parameter the way `pruneStore` does (no global mocking).
- **Verify.** `npm test --prefix cli`; CI applies every patch twice inside the pinned image.

---

## Phase 2: security

### 1. Pages read by Vane's scraper can reach Vane's own API (`chunks/641.js` module 96227, `scrape(a)`)

Facts checked: the scraper is headless Chromium (`browser.newContext`, `page.goto(a, {waitUntil:"domcontentloaded"})`),
so it follows redirects and runs page scripts; nothing filters private addresses. Vane answers `GET /api/config` with
the provider API keys and accepts `POST /api/config` (`req.json()`, any content type) with no login. Pages are read by
Quality (upstream), Balanced (Fane's `patch-web-search` `BALANCED_READ`) and the `scrape_url` tool.

- **Pattern: defence in depth at the one choke point.** Patch the scraper class once, so all three callers are
  covered, instead of checking URLs in each caller.
- **New patch** `patches/patch-scrape-guard.js` (one target, `FILES.research`, marker `/*fane:scrape-guard*/`):
  1. **Every request is routed** (`await b.route("**/*", handler)` right after `newContext`):
     - abort any request whose method is not `GET`. A scraper never needs to send data. This also stops a page
       script's `POST` to `/api/config`; a 307 redirect keeps the method, so the first hop already aborts it.
     - abort any request to a private host: a hostname check first (localhost, `*.localhost`,
       `host.docker.internal`, IPv4/IPv6 literals in private ranges), then a DNS lookup for other names
       (`require("node:dns").promises.lookup(host, {all: true})`, cached per scrape in a `Map`, so a page's 50
       sub-requests cost one lookup per host).
     - `continue()` everything else.
  2. **Service workers blocked** (`newContext({..., serviceWorkers: "block"})`), so a page cannot fetch outside the
     route handler.
  3. **Redirect chain checked after `goto`:** walk `response.request().redirectedFrom()` and refuse (return Vane's own
     `{title: "Failed to scrape", ...}` shape, `SCRAPE_FAILED_TITLE`) if any hop's host is private. Playwright calls
     the route handler only for the first URL of a redirect chain, so this closes
     `public page → 302 → 127.0.0.1:3000/api/config`; that GET already happened, but its body is discarded.
- **One rule, two layers.** The private-address rule exists in ESM (`cli/image/download.mjs` `isPrivateAddress`) and
  must also exist as injected source. Put the injected version in `patches/lib/vane.js` as `PRIVATE_ADDRESS` (source
  of an arrow function, no backticks), and add a table-driven test that evaluates it and compares it with
  `isPrivateAddress` on the same addresses: IPv4 private, CGNAT, link-local, multicast, `::1`, `fc00::`, `fe80::`,
  `::ffff:127.0.0.1`, `64:ff9b::a9fe:a9fe`, `2002:7f00:1::`, public v4 and v6. Finding 14 changes the ESM rule; the
  test makes the two move together.
- **Check before writing** (in the container, nothing paid): that `require` works inside the chunk's module function
  (`docker exec vane node -e` loading the patched chunk), and that `route`, `serviceWorkers` and `redirectedFrom`
  exist in Vane's Playwright version (`require('playwright-core/package.json').version` inside the image).
- **Tests.** Patch shape (existing), the predicate table above, and a fake-Playwright test: run the patched `scrape`
  against a fake `browser` whose route handler records `abort`/`continue` for `POST https://a.example`,
  `GET http://127.0.0.1:3000/api/config`, `GET https://a.example` (public lookup), and a `goto` whose response has a
  private `redirectedFrom` hop → "Failed to scrape".
- **Verify live.** Apply, restart, doctor. Balanced and Quality still return read pages
  (`node scripts/bench.mjs -m claude-haiku-5-5 --modes balanced,quality --only node-lts,rust-go`). Optional: a local
  test page in the container that redirects to `127.0.0.1:3000/api/config`, scraped through `scrape_url`, must come
  back as "Failed to scrape".
- **Residual risk, written in the patch header:** a page script's GET to a private host reached only through a
  redirect is not readable cross-origin (Vane sends no CORS headers), so it cannot leak; WebSockets are not routed by
  Playwright and are not covered.

### 14. Resolved IPv6 addresses pass the image download guard (`cli/image/download.mjs:20`)

- **Pattern: allow-list instead of deny-list** for IPv6 after DNS: global unicast is `2000::/3`; everything else is
  refused, plus `2002::/16` (6to4) and `64:ff9b::/96` (NAT64), which embed IPv4.
- **Change.** In `isPrivateAddress`, after the v4-mapped branch: for `isIP(v) === 6`, return true unless the first
  hextet starts with `2` or `3`, and return true for the `2002:` and `64:ff9b:` prefixes. Keep the literal-IPv6
  refusal in `safeDownload` (the stricter rule for URLs).
- **Tests** (`cli/test/image.test.mjs`): `safeDownload` with `resolve: async () => [{address: '64:ff9b::a9fe:a9fe'}]`
  and with `2002:7f00:1::` → refused; `2606:4700::1111` → allowed. The predicate table from finding 1 covers the rest.

---

## Phase 3: Quality answer check (`cli/write/quality-check.mjs`)

All four findings are in one pure module; one commit. Design: **functional core** (`citedSentences`, `checkPrompt`,
`applyVerdicts`, `checkNote` stay pure and fully tested), **imperative shell** (`checkAnswer` makes the one model
call). Live update: `docker cp` the module into `/fane/write` and `cli/core/markdown.mjs` into `/fane/core`, restart.

### New shared helper: `cli/core/markdown.mjs`

- `segments(text)` → `[{ code: boolean, text }]`: fenced blocks (``` and ~~~, length ≥ 3, closed by the same run) and
  inline code spans (backtick runs of equal length) are `code: true`, everything else is prose. One small state machine
  over lines for fences, then a regex over prose lines for inline spans.
- `mapProse(text, fn)` → the text with `fn` applied to prose segments only.
- **Why core:** phase 3 (`tidy`), phase 4 (`cleanMarkdown`) and `citedSentences` all need "prose only"; today
  `citedSentences` has its own fence toggle. One tokenizer, tested once (a fence inside a fence, an unclosed fence,
  `~~~`, an inline span containing `<`, a line of four backticks).

### 2. `tidy()` flattens code and nested lists (`:47-49`)

- **Change.** `tidy = text => mapProse(text, p => p.replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ').replace(/[ \t]+$/gm, ''))`,
  then the existing empty-list-marker and blank-run cleanup on the whole text (those never touch code: a fence line is
  never an empty marker). Leading indentation is never collapsed.
- **Tests.** The reproduced case: a Python block and a nested list survive a removal unchanged; an emptied bullet
  still disappears; the double space a removed mid-line sentence leaves still collapses.

### 3. "All supported" when nothing was checked (`:53-63`)

- **Pattern: parse, don't validate.** Normalise the reply once at the boundary into
  `Map<claimIndex, { verdict: 'supported' | 'partly' | 'unsupported', fix }>`: lower-case and trim the verdict, accept
  `partial`/`partially` as `partly`, ignore unknown ids and duplicates (the first one wins).
- **Counts from facts, not attempts.** `checked` = claims with a recognised verdict; `error: 'unreadable reply'` when
  that is 0 and there were claims; `corrected`/`removed` increase only when `text.includes(claim.text)` before the
  replacement. `checkNote` already prints "the first N of M" when `checked < total`; reword it to "N of M" so it is
  also true when the model skipped claims in the middle.
- **Tests.** `{"claims":[]}` → the error note, not "all supported"; `"Unsupported"` → removed; the same id twice →
  counted once; a reply covering 2 of 4 claims → "Checked 2 of 4".

### 7. Only 1,500 characters per source (`:12`, `:38`)

- **Change.** Replace `SOURCE_CHARS` with a total budget: `SOURCE_BUDGET = 60_000` characters, per source
  `Math.min(8_000, Math.floor(SOURCE_BUDGET / cited.length))`. Fix the comment (the writer sees the full findings).
- **Not now:** a window around the sentence's numbers or rare words. Build it only if the benchmark still shows correct
  sentences removed after the plain budget.
- **Test.** A source whose supporting fact sits at character 3,000 is in the prompt.
- **Verify.** Quality benchmark (6 questions) before and after: the corrected/removed counts in `docker logs` should
  fall for answers that cite long pages; time should not grow by more than a few seconds.

### 8. No time limit on the check (`:83`)

- **Change.** `CHECK_TIMEOUT_MS = 90_000`; `Promise.race([llm.generateText(...), timeout])`, the timer cleared in
  `finally`; a timeout takes the existing failure path (the answer shown as written, note "the check timed out").
  Vane's `generateText` takes no signal, so the call itself cannot be cancelled; say so in a comment.
- **Test.** A fake `llm` that never resolves with an injected `timeoutMs: 20` → the answer comes back unchanged with
  the timeout note, and the test does not hang.

---

## Phase 4: silent output corruption

### 4. Generated files cut at the first inner fence (`cli/code/files.mjs:40`, `:50-55`, `:64`)

- **Change in `extractCode`:** if the trimmed answer starts with a fence run `F` (``` or ~~~, length ≥ 3) and its last
  line is exactly `F`, the file is everything between the first and the last line (info string dropped). Otherwise
  keep the current logic. `parseFiles`: take each "File: path" section up to the next header, then apply the same
  outer-fence rule.
- **Why not a smarter regex:** a lazy regex cannot know which fence is the outer one; the outer-fence rule is exact for
  the shape `cli/code/prompts.mjs` asks for.
- **Tests** (`cli/test/code.test.mjs`): the two reproduced cases (a README with a bash block, a Python file whose
  string holds a JSON fence); a normal single-fence answer and a multi-file answer are unchanged.

### 5. `cleanMarkdown` strips `Promise<string>` (`cli/write/present.mjs:27`, `:34`, `:92`)

- **Change.** Strip tags only in prose: `cleanMarkdown = text => mapProse(text, stripTags)` with the existing
  until-stable loop inside `stripTags`. `articleMarkdown` escapes `<` only in prose too. Code spans render as text in
  Markdown, so no HTML hole opens; `renderPostResult` escapes everything anyway.
- **Tests** (`cli/test/write.test.mjs` or `present.test.mjs`): `` `Promise<string>` `` and a fenced HTML example
  survive; `<img onerror=…>` and the rebuilt `<<img …>img …>` case are still removed from prose.

### 15. Valid `tsconfig.json` fails the syntax check (`cli/code/syntax.mjs:36-38`)

- **Change.** Before `JSON.parse`: names matching `/(?:^|\/)(?:ts|js)config(?:\.[\w-]+)?\.json$|\.jsonc$/i` →
  `{ status: 'unchecked' }`. No JSONC parser (no dependency; "unchecked" is honest).
- **Test.** `tsconfig.json` with a comment → unchecked; `package.json` with a trailing comma → error.

### 21. Blank lines in captions and alt text (`cli/image/present.mjs:64`, `:89`)

- **Change.** Collapse whitespace where model or prompt text enters one-line HTML: `attr()` and the caption `words`
  get `.replace(/\s+/g, ' ').trim()`. One line each.
- **Test.** `renderResult` with `text: 'a\n\nb'` and a prompt with `\n\n` → the HTML has no blank line.

---

## Phase 5: routing and consistency

### 10. Polite openings differ between the three detectors (`cli/core/intent-*.mjs`)

- **Pattern: one table, composed regexes.** New `cli/core/polite.mjs` exporting `POLITE`: the openings the request
  detectors share, English and folded Greek (please, can/could you, I'd like you to, I want you to, I need you to,
  help me, let's, παρακαλω, μπορεισ να, θα ηθελα να, θελω να …). `intent-brainstorm.mjs` composes its own extra
  openings after the shared ones (`i need\s+`, `i want\s+`: "I need 10 names").
- **Test: a routing table.** One table of phrasings × expected route (article / post / code / brainstorm / none), run
  through all detectors in a new `cli/test/intent-routing.test.mjs`: every phrasing reaches exactly the expected
  detector. Include "I need you to write an article about …", "I want you to brainstorm names for …", "Help me write a
  script that …", and the existing false-positive guards ("a list of tools", "an image classifier").
- **Check.** `autoRoute` and the four hooks call the detectors in a fixed order; the table must pass with that order.

### 11. Greek function words count as evidence in `--verify` (`cli/vane.mjs:262-271`)

- **Change.** Fold before tokenizing (`fold()` from `core/language.mjs`: no accents, final sigma as sigma) and add a
  folded Greek stop list (και των την του της που για απο στο στη στην στον στις στους ενα μια οτι ειναι αυτο αυτη
  αυτα τον τις τους ηταν εχει εχουν μπορει οπωσ αλλα ενω κατα μετα πριν ουτε …). Greek stemming stays out, with a
  `shortcut:` comment (inflected forms still count as different words).
- **Test** (`cli/test/verify.test.mjs`): the Parthenon source and the tidal-energy claim → weak; a real Greek
  paraphrase → supported.
- **Note.** Greek support rates in earlier benchmark files were inflated; say so in the commit message.

### 20. The tier-to-mode rule written seven times (`cli/runners.mjs`, `cli/vane.mjs:192`)

- **Change.** `export const modeOf = (o) => MODE_FOR_TIER[o.tier] ?? o.mode;` in `runners.mjs`, used by the six
  runners and by `parseCli`'s timeout default. About −6 lines.
- **Test.** The existing runner tests; one `modeOf` case each for `tier: 'premium'` and for no tier.

---

## Phase 6: pipelines and runners

### 9. A fatal stop after the draft throws the draft away (`cli/write/pipeline.mjs:70`, `:245`)

- **Pattern: degrade, don't discard.** Once a draft exists, a `Stop` (401, 402, the spend cap; not 499, the user's own
  stop) ends the model calls but not the run: record `degraded: 'stopped after the draft: <reason>; the article was
  not edited'`, skip the remaining model phases, and run the deterministic finish (renumber, checks, sources list,
  render).
- **Change.** Keep `step()` throwing `Stop`. Wrap the post-draft model phases (fact-check and critique, revise, trims,
  audit, polish) in one `try`; in the `catch`, rethrow unless it is a `Stop` with a status other than 499, else keep
  the reason and fall through. The result gains `stopped: { status, error }`; `ok` stays true because an article
  exists.
- **Callers.** `cli/write/vane-hook.mjs` and `runArticle` already show `degraded`; check that both print the stop
  reason and that the CLI exits 0 with a warning (the money bought an article). Review `edit.mjs` (one call, nothing to
  keep) and the post format the same way.
- **Tests** (`write.test.mjs`, next to the existing fatal test at :585): a 402 on the critique → `ok: true`, the body
  is the draft, `stopped.status === 402`, no further calls; a 499 → still a stop with no article.

### 12. Article runs re-register the model on every search (`cli/runners.mjs:43-46`)

- **Pattern: single-flight memoised initialisation.** Resolve the chat model once per run and share the promise, so
  parallel first calls wait for the same work (one `docker start`, one registration).
- **Change.**
  ```js
  function vaneRetrieve(opts, mode) {
    let ready; // one provider list per run, with the chat model registered once
    const providers = () => (ready ??= getProvidersStartingVane(opts.url, DEFAULTS.container)
      .then(p => resolveChatModel(p, opts)).then(r => r.providers)
      .catch(err => { ready = undefined; throw err; }));
    return retryEmpty(async (query) => (await search({ ...opts, query, stream: false, mode }, await providers())).sources);
  }
  ```
- **Test.** Fakes for `getProvidersStartingVane` and `addOpenRouterModel` that count calls: three parallel queries →
  one fetch, one registration. If the runner's imports make that hard to fake, inject them through `opts`, the way
  `client` is injected.

### 13. A brainstorm `null` becomes a score of 0 (`cli/brainstorm/pipeline.mjs:51`, `:62`)

- **Change.** `const num = (x) => (x === null || x === '' || typeof x === 'boolean' ? NaN : Number(x));` used by
  `score` and by the probability parse. Normalisation at the boundary again: missing stays missing (`null`), and the
  existing `unscored` count and degraded note then apply.
- **Test.** `feasibility: null` → the idea is kept as unscored with the note; `probability: null` → not tagged rare.

### 23. Trial options not validated (`scripts/trial-lib.mjs:16-20`, `:102`)

- **Change.** Next to the `--budget` check: `--concurrency`, `--per-lab` and `--max` must be integers ≥ 1, else throw
  `invalid --<name>`. Write `trial.json` only when at least one model was tried.
- **Test.** `--concurrency 0` throws before any call (alongside the existing trial-lib tests, or in a new
  `cli/test/trial-lib.test.mjs`).

### 24. Code and brainstorm hooks skip their run log on early returns (`cli/code/vane-hook.mjs:42,53`, `cli/brainstorm/vane-hook.mjs:40,51`)

- **Change.** `track.finish({ ok: false })` before both early returns in each hook, as `image/vane-hook.mjs` does.
- **Do not merge the hooks now.** They are near-copies, but a shared hook factory would have to live in `write` or
  `core` because the two sibling layers must not import each other. Not worth it for four lines; note it in CLAUDE.md
  as accepted duplication with the drift risk named.
- **Test.** The hooks' "no OpenRouter key" path logs a summary line (the hook tests already take a `log`).

---

## Phase 7: web UI

### 6. The Send button's arrow vanishes on hover (`patches/patch-colors.js:119-120`)

- **Change.** Exclude filled buttons from the hover rule rather than adding an override:
  `html button[data-fane-icon]:not(.bg-\[\#24A0ED\]):not(.bg-sky-500):hover`, and the same for dark. The block
  changes, so: `COLORS_V2` = the current block (kept for the upgrade), new marker `/*fane:colors-3*/`,
  `alts: [{from: COLORS_V2, to: COLORS}, {from: COLORS_V1, to: COLORS}, {from: END, ...}]`.
- **Tests.** Extend the colors upgrade test: a stylesheet holding V2 upgrades in place; still no GitHub greys.
- **Verify.** Browser, light and dark: hover Send with text typed (enabled) → a white arrow on terracotta; hover the
  sidebar icon buttons → terracotta. Check contrast with the sRGB contrast script used for the palette.

### 22. SVG opened full size loses its inline styles (`cli/image/store.mjs:98`)

- **Change.** `"default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"`. Scripts stay blocked by
  `default-src` and `sandbox`.
- **Test.** The serve-headers test in `store.test.mjs` checks the new header.
- **Verify.** Open a stored SVG (a vector-family image) full size; it renders with its colours.

---

## Phase 8: install and CLI plumbing

### 16. Plain search path untested; a cut stream gives a misleading error (`cli/client.mjs:208-227`)

- **Change.** In `readStream`, wrap the final `handle(buf)`: a `SyntaxError` there becomes
  `Error('Vane closed the stream in the middle of the answer')`. The text printed so far stays.
- **Tests** (new `cli/test/client.test.mjs`): a `node:http` server on port 0 serving (a) a normal NDJSON stream,
  (b) a stream cut mid-line, (c) a 500 then a 200 if `postSearch` retries; plus `resolveChatModel` with a fake provider
  list (exact key, unique substring, the registration path). Real sockets, no global `fetch` mock.

### 17. CORE key trimmed by `apply.mjs` but not by the Compose entrypoint (`docker/fane-entrypoint.sh:21-24`)

- **Change.** Before the `case`: `CORE_API_KEY=$(printf '%s' "$CORE_API_KEY" | tr -d ' \t\r\n')`, the same rule as
  `apply.mjs`'s `.trim()` for what a pasted or CRLF key carries. Keep the file LF (`.gitattributes`).
- **Test.** The existing test that runs the entrypoint's sed against `renderSettings`: add a key with a trailing space
  and one with `\r`; both must render the same settings as the clean key.
- **Doctor.** When CORE is off but `CORE_API_KEY` is set in the container's environment, report `warn` ("key set but
  refused") instead of the optional `ok`.

### 19. Prune stops when another request removed a file first (`cli/image/store.mjs:47`, `:55`)

- **Change.** In `pruneStore`, a `stat` or `unlink` error with `code === 'ENOENT'` skips the entry (the file is gone,
  which is what prune wanted); other errors still throw.
- **Test** (`store.test.mjs`): a fake `fs` whose `unlink` throws ENOENT for one name → prune continues and removes the
  next oldest.

---

## Phase 9: docs, CI, full verification

- **README:** a row for `patch-scrape-guard`; updated rows for `patch-colors`, `patch-quality-check` (budget, timeout,
  honest counts), `vane --verify` (Greek), the code and article notes (fences, code spans).
- **CLAUDE.md:** the scraper guard and the shared `PRIVATE_ADDRESS` rule; `core/markdown.mjs` and `core/polite.mjs` in
  the `core` list; the colors-3 upgrade chain; the accepted code/brainstorm hook duplication.
- **Project page:** the patch count (29 with `patch-scrape-guard`) and the `apply.mjs` output (add
  `patch-scrape-guard applied (1/1 targets)`; recheck the target count of every changed patch).
- **CI:** nothing new beyond the patch (CI parses every patched bundle); the hook import step covers new `core`
  modules through the hooks.
- **Full check:** `npm test --prefix cli`; two full patch passes from the `.bak` originals in the container (the
  simulation used in this session) equal the live files; `vane --doctor` clean; the benchmark
  `node scripts/bench.mjs -m claude-haiku-5-5 --modes balanced,quality`, compared with
  `bench/results/2026-10-29T09-54-00-479Z.json` (Quality with the check) and `…T09-15-19-869Z.json` (before it).
  Expect: Balanced and Quality still read pages (scrape guard), fewer "removed" sentences in Quality (finding 7), no
  timing change beyond noise.

## Effort and risk

| Phase | Size | Risk | Live restart |
|---|---|---|---|
| 1 | ~15 lines + test | low | no |
| 2 | new patch ~40 injected lines + 2 tests; ~6 lines ESM | medium: Playwright API in Vane's version, DNS inside the chunk | yes |
| 3 | ~60 lines incl. `core/markdown.mjs` + tests | low | yes (modules) |
| 4 | ~25 lines + tests | low | yes (modules) |
| 5 | ~40 lines + routing table test | medium: routing decides which feature answers | yes (modules) |
| 6 | ~40 lines + tests | medium: the article result gains `stopped` | yes (modules) |
| 7 | ~10 lines + upgrade alt | low | no (reload) |
| 8 | ~15 lines + new client test | low | no |
| 9 | docs | low | no |

## Not covered by this plan

- Whether a scraped page could rewrite Vane's settings today was not tried; the plan closes the path without proving
  the exploit. Do not try it against the real config.
- Merging the code and brainstorm hooks (the larger fix in finding 24), Greek stemming in `--verify`, and a JSONC
  parser are left out on purpose.
- A new Vane digest needs every patch anchor re-derived, as before.
