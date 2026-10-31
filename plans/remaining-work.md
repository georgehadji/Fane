# Remaining work: plan

Seven items, in the order to do them. Each says where it sits in the layers (`core` < `image` < `write` < `code`/`brainstorm`; patches are CommonJS in the container, the CLI is ESM on the host), what is tested, and whether it costs money or needs a restart.

| # | Item | Paid | Restart | Size |
|---|------|------|---------|------|
| 1 | Append targets cannot apply twice | no | no (browser chunk) | S |
| 2 | Merge the two session branches | no | yes (SearXNG settings) | S |
| 3 | Research rounds read from the effort table | no | only when a number changes | S |
| 4 | Bench Quality at `medium` reasoning | ~$3-5 | no | S |
| 5 | Follow-up edits of social posts | no | yes (hook folder) | M |
| 6 | Follow-up edits of generated code | no | yes (hook folder) | M |
| 7 | X search through xAI `x_search` (optional) | per use | yes | M |

Not code, for you: rotate the Brave key that was pasted in chat, and add `.env.txt` to `.gitignore`.

---

## 1. Append targets cannot apply twice

**Defect.** `patch-icon-buttons`' layout target is `from: LAYOUT_END, to: LAYOUT_END + script`. The `from` still matches after patching. When the engine does not recognise `to` (the CRLF case, now fixed, or any later edit of `LABEL_ICONS`), it appends the script a second time instead of failing. Every "append at the end" target has this shape; most CSS blocks already carry a `/*fane:...*/` marker, this one does not.

**Design.** Keep the engine. Make it a rule of the target shape, checked by the existing shape test:

- A target whose `to` contains its `from` (an append) must have a `marker`, and the marker must not occur in `from`.
- `icon buttons named from their icon` gets `marker: ';(function LABEL_ICONS('`. Old and new patched text both contain it and `from` does not, so containers patched before this change count as applied and nothing is appended again.
- Any other append target the test flags gets a marker the same way (a stable prefix of its injected text).

**Files.** `patches/patch-icon-buttons.js`, any flagged patch, `cli/test/patches.test.mjs` (new test: "an append target has a marker outside its from"), one sentence in CLAUDE.md's engine rules.

**Check.** `npm test --prefix cli`; `node scripts/apply.mjs --no-searxng` twice; the container's layout chunk holds `LABEL_ICONS` once; `vane --doctor` clean.

## 2. Merge the two session branches

Order matters: the container already runs the Perplexity settings.

1. `git merge refs/heads/claude/sweet-colden-16b26a` (a CLAUDE.md note).
2. `git merge refs/heads/claude/reverent-clarke-c24640`. In `patches/lib/apply-targets.js` keep main's version (51c948c) and drop the branch's own copy of the `\r` fix (c7f6167). Re-check the README patch list and the docs patch-count test.
3. `npm test --prefix cli`.
4. Only then `node scripts/apply.mjs` from a shell that has `PERPLEXITY_API_KEY`, `BRAVE_API_KEY` and `TAVILY_API_KEY`, or the render switches those engines off. Check `docker logs --since 3m vane` first: the restart kills answers in progress.
5. `vane --doctor`; `node scripts/engine-check.mjs --engines perplexity`.

Commit and push only when asked.

## 3. Research rounds read from the effort table

Folded into `plans/balanced-mode.md` item 1, which adds the stop rule to the same table.

**Now.** `patch-quality-mode` writes `"balanced"===b.config.mode?6:10` over Vane's `?6:25`; speed's 2 is Vane's own. `EFFORT.researchRounds` (2/6/10) in `cli/core/effort.mjs` is documented as "not yet read by the patch".

**Design.** The patch cannot import the ESM table (it runs as CommonJS, and `patches/` is copied without `cli/`). Use the `IMAGE_STORE_DIR` / `ANSWER_MARKER` pattern: one copy per layer, a test proves they are equal.

- `patches/lib/vane.js`: `RESEARCH_ROUNDS = { speed: 2, balanced: 6, quality: 10 }`.
- `patch-quality-mode`'s `iteration budget` target builds its `to` from it. Speed stays Vane's literal; the test asserts it equals `RESEARCH_ROUNDS.speed` against the pinned fragment.
- Upgrade path for a later change of numbers: the target becomes `alts` with Vane's `?6:25` and the previously written `?6:10` as `from`s. Today the numbers are unchanged, so the container sees no difference and needs no restart.
- Test in `cli/test/effort.test.mjs`: `RESEARCH_ROUNDS` deep-equals `EFFORT[m].researchRounds` for every `m` in `MODES`.
- CLAUDE.md: replace "not yet read by the patch" with the test's rule.

## 4. Bench Quality at `medium` reasoning (paid)

Step 4 of `plans/effort-profiles.md`. Decides whether Quality's `reasoning: 'low'` changes.

1. Baseline at `low` (reuse `bench/articles-baseline.json` if it is Quality at `low`).
2. The same set with `--reasoning medium`. If `scripts/article-bench.mjs` does not forward it to the CLI, add a `--reasoning` passthrough, validated by `resolveEffort`.
3. Compare the judge's claim support and audit, plus cost and time. Change `EFFORT.quality.reasoning` only if the judge's numbers rise beyond `TOLERANCE`. Check no call ended with `finish_reason: length` (`HEADROOM.medium` = 16000 is a guess).

Ask before running: it spends OpenRouter credits.

## 5. Follow-up edits of social posts

**Now.** `parseArticleAnswer` needs a `# ` title; posts have none, so "make it shorter" after a LinkedIn post becomes a search.

**Design (in `cli/write`, no new layer).**

- `renderPostResult` marks the answer with its platform (one string in `cli/core/formats.mjs`, e.g. `<!--fane:post:linkedin-->`).
- `parsePostAnswer(answer)` in `edit.mjs`: platform from the mark, text from the `<p>` paragraphs (unescaped), sources from the first-comment block. Null without the mark or under 20 words.
- `createArticleEditor` takes `format`: a post uses `postEditRule` and `postChecks` and renders with `renderPostResult`. No second editor.
- Hook (`write/vane-hook.mjs`): `isArticleEdit(q)` and `parsePostAnswer(lastAnswer)` not null -> edit with that format, before the article branch.
- CLI `--edit-article` for posts: skipped in this step (named in the README).
- Tests: render -> parse round trip; routing row "make it shorter" after a post; `postChecks` run on the edited text.

## 6. Follow-up edits of generated code

**Now.** Not supported. A code answer has `CODE_ANSWER_MARKER`, `<h4>` paths, and fences from `fenceFor`.

**Design (in `cli/code`; detector in `core`).**

- `parseCodeAnswer(answer)` in `files.mjs`: needs the marker; each `<h4>` path plus the next fence (`codeBlocks`, nesting-aware) becomes `{path, content}`; every path goes through `safePath`, unsafe ones are dropped. Null when no file parses.
- `isCodeEdit(q)` in `core/intent-code.mjs`: a leading edit verb plus a code word or "it/this"; never a question. Add rows to `intent-routing.test.mjs`.
- `editCode({ files, change, client, checkSyntax, effort })` in `code/pipeline.mjs`: a `fix`-style call per file the change names (all files when it names none, at most `MAX_FILES`), the same refusal rules as a fix (not empty, not half the lines, no parse -> no-parse), a review of the changed files only, then `renderCodeResult`. No research unless the change names a library.
- Hook: if `patch-code-chat` does not pass `lastAnswer` yet, add an upgrade target like `patch-article-chat`'s (`LAST_ANSWER` from `patch-image-chat.js`), keeping the marker `patch-pipeline-abort` needs.
- Tests: round trip with a README holding a nested bash fence and a `__init__.py` path; refusal cases; unsafe path dropped.

## 7. X search through xAI `x_search` (optional)

Only if `site:x.com` on the Brave API, Tavily and Yandex finds too few posts.

`x_search` is a Grok server-side tool on xAI's Responses API, not a search endpoint, so it cannot be a SearXNG `json_engine`.

- **A: a research step next to `patch-social-sources`.** In Social mode, one xAI call per research round with `tools: [{type: "x_search"}]` and a strict JSON schema for `{url, text, date}`; results join Vane's list and are ranked with the rest. Key `XAI_API_KEY`, carried like the `KEYED_ENGINES` keys (Compose, `apply.mjs`, entrypoint; never printed); no key, no call. Cost: $5 per 1k posts plus tokens; cap `max_search_results`.
- **B: leave it out** and document that X coverage is what the web engines indexed.

Needs your decision on cost before any code.
