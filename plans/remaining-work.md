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

Not code, for you: rotate the Brave key that was pasted in chat (`.env.txt` and `.env` are already in `.gitignore`).

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

Done in `plans/balanced-mode.md` items 1-3 (the table also holds `staleRounds`; `RESEARCH_ROUNDS` and `STALE_ROUNDS` in `patches/lib/vane.js`, a test keeps them equal).

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

**Status: done 2026-11-13. Decision: Quality stays at `low`; `EFFORT.quality.reasoning` is unchanged.** `scripts/article-bench.mjs` got `--reasoning` (validated by `resolveEffort`, forwarded to the CLI, recorded in the results meta; 9667ed6). The 2026-10-27 baseline was not reused: the pipeline has changed since, so `low` and `medium` were both run fresh on `symplectic`, `glp1` and `ocean-el` (one run each, judge `openai/gpt-6.1-terra-pro`, about $1.76 in all).

| Topic | `low` support / audit | `medium` support / audit | `low` cost | `medium` cost |
|---|---|---|---|---|
| `symplectic` | 0.87 / 0.90 | 0.75 / 0.92 | $0.197 | $0.254 |
| `glp1` | 0.944 / 0.93 | 0.769 / 0.91 | $0.548 | $0.250 |
| `ocean-el` | 0.905 / 0.89 | failed (Vane research: "no sources found (fetch failed)") | $0.353 | none |

- Judge claim support fell 0.12 and 0.175 at `medium`, past `TOLERANCE.supportDrop` (0.1); audit moved by 0.02 or less; time was similar (6-8 minutes); cost was mixed (+29%, -54%) and the `low` `glp1` run, at twice the 2026-10-27 baseline, looks like noise. No article was degraded and no check failed. `medium` articles landed nearer the 600-word target.
- Limits: one run per topic, a noisy judge, and `ocean-el` at `medium` failed, so `medium` has two articles. Not checked: whether any call ended with `finish_reason: length` (`HEADROOM.medium` = 16000 is still a guess). Redo with `--runs 3` before ever raising it.
- Results: `bench/results/articles-q-low.json` and `articles-q-medium.json` (gitignored).

## 5. Follow-up edits of social posts

**Status: done 2026-11-13, pushed (086b4f8), applied and checked in the web chat.** Built as designed, with two deliberate cuts: a post edit never searches (a request to add facts gets a `degraded` note, because a post has no `[n]` markers to put a new source behind) and its sources stay as they were in the first comment. The mark is `postMark()` in `core/formats.mjs`; `cli/test/post-edit.test.mjs` holds the round trip, the editor, the routing and the failure wording. Needs `node scripts/apply.mjs` (hook folder, so a Vane restart).

**Now.** `parseArticleAnswer` needs a `# ` title; posts have none, so "make it shorter" after a LinkedIn post becomes a search.

**Design (in `cli/write`, no new layer).**

- `renderPostResult` marks the answer with its platform (one string in `cli/core/formats.mjs`, e.g. `<!--fane:post:linkedin-->`).
- `parsePostAnswer(answer)` in `edit.mjs`: platform from the mark, text from the `<p>` paragraphs (unescaped), sources from the first-comment block. Null without the mark or under 20 words.
- `createArticleEditor` takes `format`: a post uses `postEditRule` and `postChecks` and renders with `renderPostResult`. No second editor.
- Hook (`write/vane-hook.mjs`): `isArticleEdit(q)` and `parsePostAnswer(lastAnswer)` not null -> edit with that format, before the article branch.
- CLI `--edit-article` for posts: skipped in this step (named in the README).
- Tests: render -> parse round trip; routing row "make it shorter" after a post; `postChecks` run on the edited text.

## 6. Follow-up edits of generated code

**Status: done 2026-11-13, pushed (fea1b23, fix 34840e1), applied and checked in the web chat (Speed only; Balanced's review step is covered by unit tests).** Built as designed, with these differences: `parseCodeAnswer` and `pickTargets` live in the new `cli/code/edit.mjs` (it reads what `present.mjs` wrote), `createCodeEditor` returns `editCode`, a change is reviewed in Balanced and Quality but its findings are listed, not fixed (ask for the fix as the next change), the README is left out of an edit's answer, and `isCodeEdit` needs only a leading edit verb (the hook's `parseCodeAnswer` check is the real gate). `cli/test/code-edit.test.mjs` holds the round trip, the editor, the routing and the patch upgrade. Lesson from the apply: an upgrade target's `marker` must not be text another hook in the same route also holds (the article hook has the same `lastAnswer`/`history` text), or the engine reports "already patched"; the test bundle now includes an article hook.

**Was.** Not supported. A code answer has `CODE_ANSWER_MARKER`, `<h4>` paths, and fences from `fenceFor`.

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

**Status: built, applied and checked live 2026-11-13 as option A (commits 4196046, 3182e3c).** The first live runs with a real xAI key found two bugs, both fixed in 3182e3c: xAI cites `x.com/i/status/<id>` while the reply text links `x.com/<handle>/status/<id>`, so the citation check dropped every post (posts now match by status id; a test uses the real shape); and one call takes about 39 s (three server-side searches, about $0.15 with tokens), so the 45 s timeout became 90 s. After the fix a Social question logged `fane: x_search: 7 post(s) for 3 query(ies)`. The response shape is now known: a `message` item whose `output_text` holds the JSON array, `url_citation` annotations, and `max_turns: 2` leaves room for the answer. Confirmed 2026-11-13 in a finished answer: the Social question "What are people on X and Reddit saying this week about AI coding assistants?" (`vane -s discussions -m auto:smart -o speed`, freellmapi) returned 61 sources, 8 of them xAI posts ("X post by @…"), and the answer cited 7 of those 8 (about 4 minutes, `--timeout 500` needed: one `x_search` call takes 40-90 s). Differences from the design: the key is the API key of a Vane provider with Base URL `https://api.x.ai/v1` (as OpenRouter's and freellmapi's are), not `XAI_API_KEY`, because `apply.mjs` cannot add an environment variable to a running `docker run` container and a second copy of the key would be one more place to leak it; the cap is one call per `social_search` and `FANE_X_MAX_CALLS` (2) per research (xAI has no `max_search_results`); no strict JSON schema (the docs do not say whether `text.format` works with `x_search`), the reply is parsed leniently and checked against the response's own citations. Files: `cli/write/xsearch.mjs`, `patches/patch-x-search.js` (the 39th patch; README and project page updated), a marker on `patch-social-sources`' search target, `cli/test/x-search.test.mjs`. To try it: add an OpenAI-compatible provider in Vane's Settings → Models (Base URL `https://api.x.ai/v1`, your xAI key), run `node scripts/apply.mjs`, ask a Social-source question, and read `docker logs vane` for `fane: x_search:`. Each such research costs up to two calls (about $5 per 1,000 posts fetched plus tokens).
