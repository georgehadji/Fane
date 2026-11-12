# Plan: find and name the implicit state machines

An implicit state machine is behaviour that depends on a phase nobody named. Typical signs:
- a mix of flags (`stopped`, `paidOut`, `degraded`, `retried`);
- a field whose null or non-null means a phase (`result.stopped`, `earlier`, `audit`);
- a status string spelled in several files;
- a counter with a threshold;
- a fallback ladder;
- a cache with an in-flight promise;
- a "turn" that must end with one call on every exit path.

This plan lists every one found in the repo, decides for each whether to name it, and orders the work. It defers to `CLAUDE.md` for every contract it touches.

Survey: four read-only passes on 2026-11-11 (host CLI + image, write/code/brainstorm, patches, scripts/docker/docs). Every claim marked **verified** was re-read in the source. Claims marked **verify** are hypotheses, and Phase 0 checks them before anyone builds on them.

## The decision

**Name states as data in the layer that owns them. Put the transitions in one pure function, and pin them with table-driven tests. Do not add a state-machine library.**

Why this helps all three (UX, DX, AX):
- **UX.** Most user-visible faults found here come from two encodings of one state disagreeing:
  - a degraded article that logs as a clean run;
  - a `--brainstorm --article` call validated as one feature and run as another;
  - a run stopped by the user reported as a generic failure.

  One name per state removes the disagreement.
- **DX.** Phase checks scattered over closures turn into one function you can test with a table. Bugs found by this survey sit where a state was checked twice in two ways.
- **AX.** An agent editing this repo sees states only as exported names it can grep (`OUTCOME.degraded`), transition tables in tests that read like a spec, and one line per machine in `CLAUDE.md`. Today the states live in comments, regexes over error text, and the order of `if`s.

Why not something bigger:
- **No library.** The repo has zero dependencies, so no XState or any other library.
- **No class per state.** The states differ in data, not behaviour. `plans/effort-profiles.md` made the same choice for modes.
- **No rewrite of the machines that already work.** Some are well tested and drift-free (see "Leave as is"). Naming them would only churn code.

Rules every item follows:
1. **Characterize first.** Write tests that pin today's behaviour, including the cases the survey found untested. Then refactor with those tests green. A behaviour change happens only where this plan lists it under "Behaviour changes", one per commit.
2. **Additive result shapes.** Keep every field callers read today (`ok`, `stopped`, `degraded`, `status`, `fatal`). Derive the new `outcome` from them in one function, then move readers over to `outcome`. Drop no field in this plan.
3. **Layers hold** (`cli/test/boundaries.test.mjs`). Shared names go in `cli/core`, which imports nothing. CommonJS patches that need a name get a copy in `patches/lib/vane.js`, and a test keeps the two copies equal (the `IMAGE_ANSWER_MARKER` pattern).
4. **Injected functions stay ASCII and closure-free** (`CHIP`, `READ_PAGES`, `STOP`). For these, "explicit" means a small transition table inside the function, not an import.
5. **Each item lands green.** That means `npm test --prefix cli` and CI's two full patch passes plus `node --check`. Mark the item done here when it lands, and add or adjust its line in `CLAUDE.md` in the same commit.

## Inventory

How to read the table:
- **Make explicit**: name the states.
- **Test only**: add the missing transition tests and leave the code alone.
- **Leave**: covered and low risk.

The decision rule: make it explicit when at least two of these hold:
- (a) the state is encoded two or more ways;
- (b) it is copied across features;
- (c) the survey found a bug or an illegal combination in it;
- (d) it spends money or loses data when wrong.

| # | Machine | Where | States (short) | Rule hits | Verdict |
|---|---|---|---|---|---|
| M1 | Run outcome: stopped / degraded / failed | `write/pipeline.mjs:163-261`, `code/pipeline.mjs:275`, `brainstorm/pipeline.mjs:171-214`, `core/runlog.mjs:18`, image `vane-hook.mjs:95`, `policy.mjs:58` | complete, degraded, stopped-by-user, stopped-fatal (401/402/cap), failed | a b c d | Make explicit |
| M2 | Role-call chain | `write/llm.mjs:49-127` | trying, network-wait(n), paid-out, capped, stopped, exhausted, ok, ok-fallback | a c d | Make explicit |
| M3 | Phase record vocabulary | `write/pipeline.mjs:70-121`, `code/pipeline.mjs:148-239`, `brainstorm/pipeline.mjs:147-149`, three hooks' `onProgress` | running, preview, ok, fallback, failed, rejected, done | a b c | Make explicit |
| M4 | Hook turn lifecycle | `write/vane-hook.mjs:34-105`, `code/vane-hook.mjs:30-79`, `brainstorm/vane-hook.mjs:28-77`, `image/vane-hook.mjs:38-104` | declined, emitted, no-provider, no-trial, running, rendered, stopped, failed; finish exactly once | a b c | Make explicit |
| M5 | CLI feature selection | `cli/vane.mjs:222-223` (parseCli), `:265-271` (autoRoute), `:516-523` (main) | search, image, article/post, edit-article, code, brainstorm, list-*, doctor | a c | Make explicit |
| M6 | Image slot ladder | `image/generate.mjs:40-240` | slot empty or drawn; per model: tried, failed, fatal; endpoint 1/2; aspect retry; prompt rewrite | c d | Make explicit (small) |
| M7 | Patch version ladder + cross-patch markers | `alts` in `patch-colors`, `patch-type`, `patch-quality-mode`, `patch-web-search`, `patch-discover-greek`, `patch-theme-toggle`, `patch-image-chat`, `patch-mode-icons` | fresh, V1..Vn, latest, rewritten-by-later-patch | a c d (stuck UI) | Test only (sweep test) + metadata |
| M8 | Patch engine run | `patches/lib/apply-targets.js:21-89` | per target: missing, applied, upgraded, skipped, error; run: plan, tmp, bak, rename | c | Make explicit (status names + rename rollback) |
| M9 | Source card `CHIP` | `patches/patch-source-cards.js:59-149` | closed, opening(150 ms), open-unpositioned, open, closing(120 ms), muted-after-Esc, touch first/second tap, page n | c (verify) | Make explicit (in-function table) |
| M10 | Install mode + restart decision | `scripts/apply.mjs:46-143`, `docker/fane-entrypoint.sh`, `docker-compose.yml:13-43` | compose or docker-run container; clean, browser-only, server-changed | c (verify) | Make explicit |
| M11 | Code fix lifecycle per finding | `code/pipeline.mjs:115-120, 229-254` | pending, fixed, refused, unparsed, never-attempted (medium or no file) | c | Make explicit (small) |
| M12 | Article audit retry | `write/pipeline.mjs:204-217` | not run, passed, failed, retried, retry-unscored | c | Fix the bug, test it |
| M13 | Article edit route | `write/vane-hook.mjs:36-82`, `write/edit.mjs` | new, post, edit+facts, edit, declined | a | Maybe: name the route in the hook |
| M14 | NDJSON stream reader | `cli/client.mjs:209-257` | reading, partial line, error event, done, ended-without-done | c | Test + `sawDone` |
| M15 | Vane start-and-wait | `cli/client.mjs:23-59, 186-207` | reachable, starting, ready, gave-up; search retry | untested | Test only |
| M16 | Trial save rule | `scripts/trial-lib.mjs:104-125` | passed, failed, unanswered (saved for paid, not for free), aborted pool | c | Make explicit (one rule) |
| M17 | Keyed SearXNG engines | `scripts/searxng-settings.mjs`, `docker/fane-entrypoint.sh:23-42`, `apply.mjs:94-100` | off, on, refused, key-but-no-block | a | Test only + entrypoint warning |
| M18 | Docs page reveal | `docs/page.js:79-101`, `style.css:175` | hidden until `.in`; copy label 1.6 s | c (low) | Small fix |
| — | Leave as is | `runners.mjs:46-52` vaneRetrieve, `READ_PAGES`, `patch-scrape-ladder`, `patch-scrape-guard`, `STOP`, trim loop, `store.mjs` prune, `download.mjs`, `patch-quality-check`, `patch-sources-required`, `patch-new-chat`, `patch-discover-medium` cache, brainstorm rounds, fence parser | | covered or low | Leave (two get one test each, see Phase 7) |

Judged not a state machine: `resolveModel`, `core/effort.mjs`, `gate.mjs`, `catalogue.mjs` (both), `intent*.mjs`, `retryEmpty`, `mapLimited` (part of M1), `doctor` (a checklist), `patch-weather`, `patch-image-ui`, `patch-theme-toggle`'s mounted guard, CSS bodies, `CACHE_FOR`, `bench.mjs` folds.

## Phase 0: verify the hypotheses (read-only, no code)

Run before any item that depends on them. Each one is a short subagent task; record its answer under the item it affects.

| Check | Question | Model |
|---|---|---|
| V1 | Under Compose (`/fane/*` mounted `:ro`, `docker-compose.yml:15-27`), what does `node scripts/apply.mjs` do? Today it looks like: patches run, `rm -rf` on a read-only mount fails, `changed` is already true (`apply.mjs:82`), Vane restarts, and the entrypoint re-applies everything from the mounts. Confirm with a dry read of the code path or a run against a test container. Do not touch the user's `vane` container without asking. | sonnet |
| V2 | Does a `docker run` container (no Fane entrypoint) ever rewrite `/etc/searxng/settings.yml` on restart? If it does not, the "two writers" loop is Compose-only. | haiku |
| V3 | In `CHIP`: can a 150 ms hover timer firing between `pointerdown` (`wasOpen` captured, `:132`) and `click` make a touch tap call `preventDefault` on an already-open card? Write the failing test only, against the fake React of `cli/test/source-cards.test.mjs`. | sonnet |
| V4 | `image/vane-hook.mjs:93` maps stored URLs by `d.model === i.model`. When fallbacks cycle and one model fills two slots, does the second image get the first one's URL? Write the failing test only. | sonnet |
| V5 | `apply-targets.js:81`: if a rename throws midway, list the files left in each state (patched, `.fane-tmp`, `.bak`). Confirm with a fake `io` in a test. | haiku |

**Answers (2026-11-11, read from code, not run):**
- **V1: hypothesis mostly wrong.** Under Compose, `apply.mjs` copies the patches to `/tmp` (not a mount), the patches report "already patched", and the `/fane/*` hashes equal the mounts, so nothing is removed or copied and `changed` stays false. The `rm -rf` on a read-only mount happens only if the mounts hold other files than the checkout (`apply.mjs:82-83`; the catch at `:122-125` swallows it, skips the SearXNG step, restarts and exits 1). The real fault: when the host shell lacks a key the container got from Compose (`CORE_API_KEY` …), the rendered settings differ, `apply.mjs` copies them (`:114`) and sets `changed`, so Vane restarts for nothing on every run, and the entrypoint writes the settings again. Phase 9 targets that, not the `rm` failure.
- **V3: the timer race is not a bug.** A hover timer firing between `pointerdown` and `click` leaves `wasOpen` false, so the tap is prevented and the card stays open; a card closed in between still navigates on the second tap (both pinned in `source-cards.test.mjs`). A different bug: `touch` and `wasOpen` keep the last `pointerdown`'s values, so a click with no `pointerdown` (Enter on the chip, a screen reader) right after a touch tap that opened the card is swallowed. Test is `todo`; Phase 8.3 fixes it (reset `touch` on a mouse or key event).
- **V5: confirmed.** The renames at `apply-targets.js:81` sit outside the `try`. When the second rename throws: `a.js` patched and `a.bak` exists; `b.js` original with `b.fane-tmp` left behind and `b.bak` written; the error escapes with no rollback. A rerun with a working file system heals it. The desired-behaviour test is `todo` in `patches.test.mjs`; Phase 8.2 fixes it.
- **V2: confirmed.** Nothing in the repo rewrites `/etc/searxng/settings.yml` on restart of a `docker run` container; only the Compose entrypoint (`fane-entrypoint.sh:16`) and `apply.mjs:113` write it. Whether the pinned image's own entrypoint touches it is not in the repo (unconfirmed). The two-writers case is Compose-only.

## Phase 1: small fixes the survey found (behaviour changes, one commit each)

**Status: 1.1, 1.2, 1.3 and 1.4 done 2026-11-11, with tests (`write.test.mjs`, `write-hook.test.mjs`, `brainstorm.test.mjs`); not committed.**

Every fix is local, needs no new names, and comes with a test that fails before the fix.

1. **Audit retry wording** (`write/pipeline.mjs:213-215`). When the second audit gives no score, the degraded list says both "no quality score" and "failed twice". Say "the retry produced no score" once instead. Layer: write. Test: `write.test.mjs`, a second audit that fails. Restart: yes (hook module, through `apply.mjs`).
2. **Article hook finish on early exits** (`write/vane-hook.mjs:56-58, 67-69`). Call `track.finish({ ok: false })` the way the code and brainstorm hooks do. Also catch the `trial.json` read (`:60`) into `{}`, so a missing file shows "No text model has passed…" instead of an ENOENT. Test: copy `code.test.mjs:512` ("a run that ends early…") into `write-hook.test.mjs`. Restart: yes. Phase 4 later makes this structural.
3. **Brainstorm first progress line** (`brainstorm/vane-hook.mjs:33`). Use `useMode`, not raw `mode`. Test: an invalid mode shows the pipeline's first phase. Restart: yes.
4. **Docs reveal fail-safe** (`docs/page.js`). Add `.in` in a `finally`, or move the `.js` class after setup, so a throw cannot leave `[data-rise]` hidden. Clear the copy-label timer before setting a new one. No restart. Check with the taste skill's `inspect.mjs` (0 FAIL).

## Phase 2: one outcome vocabulary (M1, M3). The keystone

Everything after this phase reads these names.

**New:** `cli/core/outcome.mjs`. It imports nothing; `STOPPED_STATUS` moves here from `core/runlog.mjs` and `runlog` re-exports it.
- `OUTCOME`, frozen: `complete`, `degraded`, `stopped`, `failed`.
- `PHASE`, frozen: `running`, `preview`, `ok`, `fallback`, `failed`, `rejected`, `skipped`.
- `isStopped(x)`: true for status 499 or an error whose text starts with `stopped:`. It replaces the regexes at `image/vane-hook.mjs:95` and `image/policy.mjs:58`, and the `=== 499` checks.
- `outcomeOf(result)`: pure; derived from today's fields.
  - `stopped`: `status === 499`.
  - `degraded`: `ok`, and either `degraded.length` or `stopped` is set (the post-draft fatal stop).
  - `complete`: `ok` with neither.
  - `failed`: everything else.

**Readers move over:**
- `runSummary` logs `outcome`. It also logs `degraded` as a count, because a degraded finish is invisible today (**verified**, `runlog.mjs:18`). Keep the `stopped: true` key for log greps.
- The three pipelines build phase records with one helper, `phaseRecord(name, status, extra)`. The helper refuses a status that is not in `PHASE`, which kills the spelling drift.
- The fix-after-emit mutation (`write/pipeline.mjs:99-100`, `code/pipeline.mjs:239`) emits a second record instead of mutating one already sent.
- Presenters read `outcome` where they read `ok` or `stopped` today.

**Tests:**
- `cli/test/outcome.test.mjs`: a table from result shapes to `outcomeOf`, including the three shapes runlog sees today (full result, `{ ok: false }` from early exits, an edit result with no phases).
- Hooks' `onProgress` tests assert only `PHASE` values.

Cost: medium. No model calls. Restart: yes, once, for the hook modules. Subagent: sonnet.

## Phase 3: role-call chain (M2)

**Status: done 2026-11-11, not committed.** `nextStep` (stages `before`, `after`, `end`), `STOP_REASONS` and a `reason` on every fatal are in `write/llm.mjs`; the four behaviours are pinned and the table has 28 rows. No caller switched to `reason` yet (none needed it: `write/pipeline.mjs` already used `isStopped`). Known choices recorded in `CLAUDE.md`: 429 grows the wait, `offline` survives a bad answer, `spent` and `paidOut` are per caller.

`createRoleCaller` (`write/llm.mjs:49-127`) handles seven outcomes in one loop.

**Name them.**
- Add `nextStep(attempt) -> { kind, wait? }`. It is pure. Its kinds are `answer`, `nextModel`, `waitThenNext`, `stop`, `softFail` and `skipPaid`. Inputs: the HTTP status, timeout or not, answer flaws (length, empty, think, not JSON), `spent` against `maxCost`, and `paidOut`.
- The loop becomes `while` + `switch` on `kind`. Every fatal result carries a `reason` from one set: `401`, `402`, `499`, `cap`. Today the cap has no `status`, and callers tell it apart by `status === undefined` (`write/pipeline.mjs:220`).

**Characterize first:**
- a 429 counts as a network failure and grows the wait (`llm.mjs:47`);
- `offline` resets on a non-network error but not on a bad answer (`:84` against `:117`);
- `paidOut` is shared by parallel steps;
- the cap overshoots by the calls already in flight.

The first two have no test today. Keep all four behaviours. Record the 429 one as a known choice in `CLAUDE.md`, not a fix, unless the user decides otherwise.

**Test:** the table in `write.test.mjs`. Each row: input attempt, expected step. **Cost:** medium. **Restart:** yes. **Subagent:** sonnet.

## Phase 4: one hook turn (M4)

**Status: done 2026-11-11, not committed.** `cli/core/turn.mjs` (`createTurn`: `run`, `progress`, `say`, `spend`, `settle`, `finish`) and all four hooks moved over (each shorter: write 107 to 94 lines, code 79 to 68, brainstorm 77 to 66, image 105 to 92). `generate` returns `fatal`, and the image hook reads `isStopped(result.fatal)`. `turn.test.mjs` holds the lifecycle table and one parametrized test over the four hooks (it replaced the three per-hook "ends early" tests). Known limits (the cost one fixed 2026-11-12: step records carry `cost` and the turn spends it, the image hook feeds `spend()` from each landed image); a failing `emit` still propagates, as before.

The four hooks repeat the same lifecycle, and the copies have already drifted (Phase 1 items 2 and 3).

**Decision:** move the skeleton into `cli/core/turn.mjs`. This reverses the `CLAUDE.md` line "four lines of drift risk accepted", because the drift happened. `core` imports nothing, so the feature-specific parts are injected: `tagged`, the renderers and `beginRun`'s prompts.

**Skeleton:** `createTurn({ feature, prompts, emit, update, log, tag })` returns `{ say, progress, run }`.
- `run(fn)` emits once and runs `fn` inside `try/finally`. It calls `finish(outcome)` exactly once on every path, early returns included, and turns a throw into `OUTCOME.failed` with the phases and cost seen so far. Today the catch logs `{ ok: false }` and loses the spend.
- `progress` is the ordered update queue that each hook hand-rolls today.
- Each hook keeps its own classification (`return false` before `createTurn`) and its own rendering.

**Image hook:** it moves over too. Its stop check becomes `isStopped(result.fatal)`, and `generate` returns `fatal` (it does not today).

**Tests:** one `turn.test.mjs` table (throw, early return, double finish ignored, queue order). The per-hook "ends early" tests become one parametrized test over all four hooks.

**Cost:** medium-high: four files, but each gets shorter. **Restart:** yes. **Subagent:** sonnet, one hook per commit after the skeleton.

## Phase 5: CLI feature selection (M5)

**Verified:** `parseCli` ranks image > article > code > brainstorm (`vane.mjs:223`), while `main` runs image > code > brainstorm > edit-article > article (`:516-521`). So `--brainstorm --article` is validated as an article and run as a brainstorm. `autoRoute` has a third order, which is deliberate and tested by `intent-routing.test.mjs`.

**Change:**
- Add `featureOf(values)`, the one table, used by `parseCli` and `main`.
- Two explicit feature flags (image, article/post/edit-article, code, brainstorm) are a `UsageError`, exit 2. `--post` sets `article` internally, so it does not count twice.
- `autoRoute`'s own order stays as it is (an intent order, not a flag order), with a comment pointing at both.

**Behaviour change:** a combination that ran an arbitrary feature now exits 2 with a message. It was never documented, and the README option table shows one feature per call. Mention it in the README.

**Test:** `vane.test.mjs`, a table of flag combinations to a feature or a usage error. **Cost:** low. **Restart:** none (host CLI). **Subagent:** haiku.

## Phase 6: degraded finish for code and brainstorm (M1, behaviour change)

**Status: done 2026-11-12, not committed.** Code: a refusal after the first file (also in the middle of `generate`, with the files that landed) returns ok with `stopped`, the stop note first in `degraded`, and the README says the run was stopped. Brainstorm: a refusal after the first idea returns the ideas so far (themes when the clustering finished). 499 and a refusal before any output still fail. CLI: `--code` and `--brainstorm` exit 1 when `stopped` is set; the files and ideas are still written or shown (the article CLI exits 0). M11: the state field is `fixState` (not `fix`, which already holds the reviewer's advice) with `fixNote`, `FIX` exported from `code/pipeline.mjs`; the notes show in the README, the web answer and the CLI report. Presenters needed no new wording: the stop note is a `degraded` entry. Tests in `code.test.mjs` and `brainstorm.test.mjs`, hook tests included.

The article pipeline keeps its paid draft when a 402 or the spend cap stops it after the draft. Code (`code/pipeline.mjs:275`) and brainstorm (`brainstorm/pipeline.mjs:171-214`, `if (x.fatal) return fail(...)` four times) throw their paid files and ideas away. The comment at `write/pipeline.mjs:163` gives the reason ("it was paid for"), and the same reason holds for the other two.

**Change:**
- **Code:** a fatal stop after `generate` returns the files written so far. Findings not yet fixed stay in `open`. The outcome is `degraded`, with `stopped: { status, error }`.
- **Brainstorm:** a fatal stop after the first round returns the ideas so far, with themes when clustering finished. 499 still returns nothing, as in the article pipeline.
- **CLI:** for code, `--out-dir` is written for a degraded result too, and exit code 1 stays.

**Tests:** `code.test.mjs` and `brainstorm.test.mjs` mirror `write.test.mjs` "a 402 in the fact-check…" and "a stop by the user (499) after the draft…". **Cost:** medium. **Restart:** yes. **Subagent:** sonnet.

Code fix lifecycle (M11), in the same phase:
- Give each finding a `fix` state: `pending`, `fixed`, `refused`, `unparsed`, `notAttempted`.
- `open` is then the findings that are not `fixed`, instead of "absent from `fixes`" plus `!i.file` (`code/pipeline.mjs:254`).
- The README's "Not fixed" list prints the reason. That is a UX gain: a user can tell "refused because it broke the parse" from "medium, not attempted".
- Behaviour stays the same otherwise.

## Phase 7: image ladder (M6) and the small machines

1. **Image slots** (`image/generate.mjs`).
   - Each slot keeps `{ attempts: [{ model, endpoint, outcome }] }`, and the hook maps a stored URL by slot index, not model id. This fixes V4 if V4 confirms it.
   - Pass the run `signal` to `safeDownload` and to `keepsReference`, so a stopped run stops downloading.
   - A failed vision check keeps the image, as today (`generate.mjs:135`), and now records `outcome: 'unchecked'`.
   - Tests: `image.test.mjs`, two slots with one model, and a stop while sibling chains are calling. Restart: yes. Subagent: sonnet.
2. **Stream end** (`client.mjs:209-257`, M14). Track `sawDone`. A stream that ends cleanly without `done` becomes "Vane closed the stream in the middle of the answer", which is the existing message. Behaviour change: such a truncated answer now exits 1 instead of 0. Test against the real `node:http` server in `client.test.mjs`. Subagent: haiku.
3. **Start-and-wait** (M15). Test only, with `execFileSync` and `fetch` injected: unreachable, then started, then ready; and gave up after the deadline. Subagent: haiku.
4. **Trial save rule** (M16, `scripts/trial-lib.mjs:111`).
   - Today an unanswered paid model is saved as FAIL; a free one is not saved.
   - Decision: one rule. An unanswered model is not saved, whether paid or free, so the next trial tries it again. A rate limit is not a verdict.
   - On a 401/402 pool abort, wait for the workers in flight before writing `trial.json` (`:118-125`).
   - Test: `trial-lib.test.mjs`. Subagent: haiku.
5. **Leave-list tests.**
   - `patch-new-chat`: a test that the first message of a chat started at `/` survives (the `replaceState`-before-add order).
   - `codeBlocks`: a test of a 4-backtick labelled fence inside a 3-backtick block. CommonMark closes the outer block on a bare 4-backtick line, so the current behaviour is correct; pin it.
   - Subagent: haiku.

## Phase 8: patch machines (M7, M8, M9)

1. **Version ladder sweep** (M7).
   - Add a test in `patches.test.mjs`. For every target with `alts`, build a fixture from each `alts[k].from`, apply, and assert that the result contains the target's latest `to` (or marker). Apply again and assert no change.
   - Extend the existing cross-patch check: run all patches in file order on fixture bundles, then re-run each patch alone, and every target reports already applied.
   - Add an optional `ladder: ['V1', 'V2', …]` label per `alts` entry. Error messages then say "found 0 (known versions: fresh, V1, V2)" instead of bare counts. This is the AX gain: an agent editing a `to` learns that a frozen earlier version exists.
   - No bundle change. No restart. Subagent: sonnet.
2. **Engine statuses and rename rollback** (M8).
   - `planPatch` returns a `status` per target, one of `applied`, `upgraded`, `already`, `skipped`, `error`, next to today's arrays. The end-of-run line counts them, so "patched N of M" stops undercounting already-applied targets.
   - If a rename throws (V5), write back the original contents already in memory (`contents[f]`, not `.bak`: `.bak` holds the first-ever original, `:72`) to the files already renamed, then remove the leftover `.fane-tmp` files.
   - Test with the fake `io`. No restart by itself. Subagent: sonnet.
3. **`CHIP`** (M9).
   - Inside the injected function, a table `T[state][event] -> state` and one `send(event)`. The events are enter, leave, focus, blur, esc, tap, away, scroll and timer. The five refs it uses today become one `state` ref plus the timer.
   - It stays closure-free and ASCII.
   - Fix what V3 confirms. Also reset `touch` on a mouse pointer event, and clear `hover` on Esc.
   - Tests: drive events through the fake React in `source-cards.test.mjs`, one row per transition.
   - Browser chunk only: a page reload, no restart. Subagent: sonnet.

## Phase 9: install mode and restart decision (M10)

Build this only after V1 and V2 report.
- `apply.mjs` reads the container's entrypoint and mounts (`docker inspect`). If the container runs `fane-entrypoint.sh` with `/fane/*` mounted, it says so and stops with "this container is managed by Compose: run `docker compose restart vane`", instead of half-running. This removes the "two writers of settings.yml" case at its root.
- The restart decision comes from what was written, not from a patch's static `TARGETS` (`apply.mjs:58`):
  - The patch prints the files it changed. Output format: one more line `<name>: changed <file>`, which `run()` already knows as `changed`.
  - `needsRestart` reads that list.
  - This also covers `patch-image-chat` running `patch-image-serve` in one `run()`.
- `apply.mjs` gets a test seam: `docker` injected, like `run(name, targets, io)`. Its decision table (clean, browser-only, server-changed, Compose-refused) is then tested.
- Keyed engines (M17): the entrypoint prints a warning when a key is set but its engine block does not match, the same warning `apply.mjs` gives. Extend the existing shell-parity test.

**Cost:** medium. **Restart:** none by itself. **Subagent:** sonnet; V2 and the M17 warning on haiku.

## Order and cost

| Order | Phase | Depends on | Size | Restart |
|---|---|---|---|---|
| 1 | 0 verify | none | small | none |
| 2 | 1 fixes | none | small | hook modules |
| 3 | 2 outcome vocabulary | 1 | medium | hook modules |
| 4 | 3 role-call chain | 2 | medium | hook modules |
| 5 | 5 CLI feature | none (parallel with 2-4) | small | none |
| 6 | 4 hook turn | 2 | medium-high | hook modules |
| 7 | 6 degraded code/brainstorm | 2, 3 | medium | hook modules |
| 8 | 7 image + small | 2 (image), none (others) | medium | hook modules |
| 9 | 8 patches | 0 (V3, V5) | medium | page reload (CHIP) |
| 10 | 9 install mode | 0 (V1, V2) | medium | none |

Can run in parallel (no shared files): Phase 5, Phase 8 and Phase 9 next to the 2 → 3 → 4 → 6 chain. Phase 7.2-7.5 can run anywhere.

No item makes a paid model call. Nothing here needs `article-bench.mjs`, because no prompt changes. Run `bench.mjs` only if Phase 3 changes timing, and it should not.

## Subagent use

- **Sonnet 5.5:** design-carrying work. Phase 2, 3, 4 and 6, M6, the patch phases, V1, V3, V4.
- **Haiku 5.5:** mechanical or narrow work. Phase 5, 7.2-7.5, V2, V5, the M17 warning, the `CLAUDE.md` index lines.
- One writer per file set at a time. Each brief names its files, the characterization tests to write first, and the "Behaviour changes" it may make; anything else is out of scope.

## Done means

- Every "Make explicit" row has exported state names, one transition function or table, and a table-driven test.
- Every "Test only" row has its missing transitions tested.
- Every Phase 0 check has an answer recorded under its item.
- `CLAUDE.md` has a short "State machines" index: one line per named machine with its file and its names. Rows are updated in the commits that land them, not as a second source of truth.
- `npm test --prefix cli` and CI are green; `vane --doctor` passes on the dev container after the last restart.

## Behaviour changes (complete list)

1. Audit retry wording (Phase 1.1).
2. Article hook logs a summary on early exits, and a missing `trial.json` shows the "no model passed" message (1.2).
3. Brainstorm first progress line uses the resolved mode (1.3).
4. Docs page cannot stay hidden after a script error (1.4).
5. Run logs carry `outcome` and a `degraded` count (2).
6. Two feature flags exit 2 (5).
7. Code and brainstorm keep paid output on a fatal stop after work exists (6).
8. The image hook maps URLs by slot; a stopped run stops downloads (7.1).
9. A stream without `done` exits 1 (7.2).
10. Unanswered paid models are not saved by a trial (7.4).
11. `apply.mjs` refuses a Compose container, and restarts only for files actually written (9).
12. `CHIP` touch and Esc fixes, as confirmed by V3 (8.3).

Anything not on this list must not change.
