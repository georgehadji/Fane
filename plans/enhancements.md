# Enhancements: plan

Nine items, from the suggestions of 2026-11-13. Each says where it sits in the layers (`core` < `image` < `write` < `code`/`brainstorm`; patches are CommonJS injected into Vane's bundles, the CLI is ESM on the host), the design and the pattern behind it, the files, the tests, what it costs and whether it needs a restart. CLAUDE.md stays the source of truth for the contracts; mark an item done here as it lands.

| # | Item | Phase | Paid | Restart | Size |
|---|------|-------|------|---------|------|
| 7 | freellmapi and Ladder survive a reboot | A | no | no (other containers) | S |
| 8 | `--doctor` checks Ladder, freellmapi and restart policies | A | no | no | S |
| 0 | Shared summary-question parser (enables 1 and 4) | B | no | no | S |
| 1 | A summary reads only its page | B | no | yes (server chunk) | M |
| 4 | The Σύνοψη citation is enforced in code | B | no | no (browser chunk) | S |
| 2 | Discover route cache (stale-while-revalidate) | C | no | yes (server route) | M |
| 6 | Discover drops repeated stories | C | no | yes (same route) | S |
| 5 | Discover finds pictures for magazine stories | C | no | yes (same route) | M |
| 3 | x_search is a per-mode budget (none in Speed) | D | saves money | yes (server chunk + write folder) | S |
| 9 | Report mode (Deep-Research-style) | E | ~$3-5 to tune | yes (hook folder) | L |

Order: A first (it is what broke on 2026-11-13: "fane not running"), then B, C, D, E. Phases B, C and D touch disjoint files (`FILES.research` + `FILES.chatClient`; `FILES.discoverRoute`; `cli/write/xsearch.mjs` + `cli/core/effort.mjs` + `patch-x-search`), so they can run in parallel sessions if each commits only its own files. B and D both edit `FILES.research`, at different anchors; the second to land must re-run `patches.test.mjs`' chain with the other's output. E builds on nothing here but is the largest; do it last.

Paradigms used throughout, all already the house style:

- **Functional core, imperative shell.** Every injected function (`CHIP`, `READ_PAGES`, `MEDIUM` today) is pure or takes its I/O as a parameter, is exported and tested on the host; the bundle only wires it to Vane's handles. New injected code follows the same rules: no imports, no closure, ASCII, no backticks, `\r`-free.
- **Dependency injection.** Fetch, scrape, clock and DNS come in as parameters (`fetchImpl`, `d.scrape`, `now`), so tests need no network.
- **Table-driven policy.** What a mode may spend lives in `cli/core/effort.mjs` (`EFFORT`), with a copy in `patches/lib/vane.js` held equal by a test, as `RESEARCH_ROUNDS` and `STALE_ROUNDS` are.
- **Upgrade ladders.** A change to text already written into containers gets an `alts` entry from the previous text, labelled in `ladder`, never a second insertion.
- **Explicit state machines** where a thing has a life (the cache entry in item 2), written as a transition table and listed in CLAUDE.md's State machines index.

Every new patch: README row, `docs/index.html` patch count ("Forty-one" becomes "Forty-four" after B and C) and its apply-output line, CLAUDE.md paragraph; the count test in `patches.test.mjs` fails until all three agree. CI applies every patch twice and `node --check`s every bundle with a `.bak`.

---

## Phase A: services that stay up

### 7. freellmapi and Ladder survive a reboot

**Now.** freellmapi runs as `npm run dev` from `C:\Users\tesse\Documents\Vibe Coding\freellmapi` (a plain background process: gone after a reboot or a Docker restart). `weebot-ladder` has restart policy `no`. `vane` has `unless-stopped`. On 2026-11-13 all three were down and a summary chat hung at "Brainstorming..." on `ECONNREFUSED` to port 3001.

**Design.** Not Fane code: freellmapi is its own repository and already ships a `Dockerfile` and a `docker-compose.yml` (port `127.0.0.1:3001`, `restart: unless-stopped`, a `/api/ping` healthcheck, `env_file: .env`, named volume `freellmapi-data` at `/app/server/data`).

1. **Back up first.** The dev database is `server/data/freeapi.db`; the image's default path is `freellmapi.db` and the provider keys in it are encrypted with `ENCRYPTION_KEY` from `.env`. Copy `server/data/` somewhere outside the repo before anything else. Losing it loses every provider key typed into freellmapi.
2. A local `docker-compose.override.yml` in the freellmapi folder (untracked there) that replaces the named volume with a bind mount `./server/data:/app/server/data` and sets `FREEAPI_DB_PATH=/app/server/data/freeapi.db`, so the container uses the same database file and key as the dev server. Stop the dev server before the first `docker compose up -d` (two writers on one SQLite file).
3. `docker update --restart unless-stopped weebot-ladder`.
4. Vane's provider Base URL stays `http://host.docker.internal:3001/v1`: Docker Desktop forwards `host.docker.internal` to ports published on the host's 127.0.0.1. Check it from inside the `vane` container before deleting the dev-server habit.
5. Docker Desktop's "Start when you sign in" is a setting for the user, not for a script; name it in the README.

**Fane files.** README, "Free models (freellmapi)": a paragraph on running it under Docker with the override, and the Ladder restart command. No code.

**Check.** Restart Docker Desktop; `docker ps` shows `vane`, `weebot-ladder` and `freellmapi` up; a Speed chat on `auto:fast` answers; `vane --doctor` (item 8) clean.

### 8. `--doctor` checks Ladder, freellmapi and restart policies

**Now.** `doctor()` in `cli/vane.mjs` checks Docker, the `vane` container, the Vane API, patches, hook folders, SearXNG and CORE. It says nothing about Ladder or freellmapi, so "fane not running" needed manual digging.

**Design.** Table-driven, like the `MODULES` list already in `doctor()`:

- `SERVICES`: `[name, url, why, fix]` rows. Ladder's URL is the container's `FANE_LADDER_URL` (read with `docker exec vane printenv`, default `http://host.docker.internal:9081`; empty means the fallback is off, which is `ok`, not a warning). freellmapi's is the origin of the Vane provider whose key starts with `freellmapi-`, plus `/api/ping`. That URL comes from `/api/config`, which also holds API keys: reuse the helper `openRouterBaseUrlWarning` already uses to read only `baseURL`, and never print or keep the key. No such provider: no row.
- Each probe runs **inside the `vane` container** (`docker exec vane node -e "fetch(...)"`, 5 s timeout), because what matters is what Vane can reach, not what the host can (`host.docker.internal` resolves only there).
- A pure `classifyProbe({status, error})` → `{level, message}` (ok, or warn with the start command: `docker start weebot-ladder`, `docker compose up -d` in the freellmapi folder). Warn, never FAIL: both are optional.
- Restart policies: one `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}'` for `vane` and `weebot-ladder` (and `freellmapi` when it exists); `no` is a warn naming `docker update --restart unless-stopped <name>`.

Not built: a `--doctor --fix` that starts the services itself (the CLI already starts `vane`; starting containers the user did not name is a step further).

**Files.** `cli/vane.mjs` (`doctor`, exported `classifyProbe` and the probe script builder), `cli/test/vane.test.mjs`, README's doctor section, CLAUDE.md one line.

**Tests.** `classifyProbe` table: refused, timeout, 200, 401 (freellmapi up but the ping needs no key, so 401 means a different service on the port: warn), empty Ladder URL. The probe script string parses (`new Function`).

**Check.** Stop Ladder, run `vane --doctor`: one warn line with the start command; start it, ok.

---

## Phase B: the summary page

### 0. One parser for the summary question

**Now.** Three places know the shape «Περίληψη: <title>\n<address>»: `patch-discover-summary-greek` writes it (`ASK`), `patch-summary-heading` reads it in the browser (`ISSUM`, `HEADING`), and `patch-answer-language`'s prompt describes it. Items 1 and 4 need to read it on the server too.

**Design.** `SUMMARY_QUESTION(q)` → `{title, url} | null` in `patches/lib/vane.js`, written as injectable source (like `LANG`): the word built from char codes (the bundle stays ASCII), the bare-address form (no title) accepted, only `https?:` addresses. A contract test: `SUMMARY_QUESTION(ASK(title, url))` returns them back for a table of titles (Greek, with `&`, a long title) and the untitled form. `patch-summary-heading`'s injected text is left as it is (it is in containers; changing it would need an upgrade target for no gain); the test also checks that `ISSUM` and `SUMMARY_QUESTION` agree on the same table.

**Files.** `patches/lib/vane.js`, `cli/test/patches.test.mjs`.

### 1. A summary reads only its page

**Now.** A summary question runs Vane's whole research: the classifier, then 2 (Speed) to 10 (Quality) rounds of researcher-model calls and web searches, then the writer. The question already names the one page that matters; the searches cost time and bring in sources about other things.

**Design.** A new patch `patch-summary-source` (server, `FILES.research`, module 87044) short-circuits `research(a,b)`:

```
async research(a,b){{let S=await FANE_SUMMARY_SOURCE(a,b,FANE_SUMMARY_DEPS);if(S)return S}let c=[],d=...
```

- `SUMMARY_SOURCE(a, b, d)` (exported, tested): `SUMMARY_QUESTION(b.followUp)`; null → return null (Vane's research runs as before). Otherwise emit the research block with one reading sub-step (the sub-step shape is Vane's own; read it from the bundle's `emitBlock` calls), scrape the address through Vane's scraper class (module 96227, already wrapped by `patch-scrape-guard` and `patch-scrape-ladder`, so the private-address guard and the paywall fallback apply), and return `{findings: [], searchFindings: [{content, metadata: {title, url}}]}` after emitting the `source` block exactly as Vane's own `return` does.
- **Fallback is the default path.** Scrape fails, times out (a race like `READ_PAGES`', 20 s), returns `SCRAPE_FAILED_TITLE`, or has under 400 characters of text: return null and let Vane research as today. A summary never ends with nothing.
- Page text is cut to `SUMMARY_CHARS` (12 000, in `patches/lib/vane.js`) and `</scraped_data>` removed, as `READ_PAGES` does; the writer prompt's summary rule already treats it as the only source.
- The module handle for the scraper is captured at module level (`FANE_SUMMARY_DEPS={scrape:u=>…A.scrape(u),…}`) through the module's import list, as `patch-web-search`'s `HANDLES` does; inside `research()` the single letters are shadowed.
- The classifier call before research stays (it also feeds the suggestions); skipping it is a second, separate patch if the timing shows it matters.

Interplay: `patch-quality-mode`'s anchors are inside the loop and on `?6:25`, untouched; `patch-sources-required` sees one finding and lets the writer run; in Quality, `patch-quality-check` checks the answer against that page. The target is an insertion (`to` contains `from`), so it carries `marker: 'FANE_SUMMARY_SOURCE('`.

**Files.** `patches/patch-summary-source.js`, `patches/lib/vane.js` (`SUMMARY_CHARS`), `cli/test/patches.test.mjs` (fake research module: a summary question returns one finding and emits `source`; a failing scrape and a thin page fall through to Vane's loop; a normal question never calls the scraper), README, docs count, CLAUDE.md.

**Measure.** Before and after, three Discover summaries in Speed and Balanced (one Greek article, one English, one paywalled through Ladder): time to the first answer token and sources count. Expected: Speed under half the time, one source.

### 4. The Σύνοψη citation is enforced in code

**Now.** The writer prompt asks for `[1]` at the end of the Σύνοψη paragraph; freellmapi's `auto:fast` left it out once. After item 1 a summary has exactly one source, so the rule is deterministic.

**Design.** A pure, idempotent `CITE_SUMMARY(text, query, sourceCount)`: when `SUMMARY_QUESTION(query)`, `sourceCount === 1`, the text has a `## Σύνοψη` heading followed by a paragraph that is **complete** (the next heading has arrived; while streaming, the paragraph is left alone) and that paragraph has no `[n]`, append ` [1]` to it. Applied in `FILES.chatClient` just before Vane's `[x]` rewrite (the same chain `patch-source-cards`' `MERGE` extends), so the inserted `[1]` becomes a chip like any other. File order: `patch-summary-cite` runs after `patch-source-cards`; its anchor must not be inside `MERGE`'s `to`. Verify in the bundle that the query and the source count are in scope there; if the query is not, pass it from the message object the chunk already holds.

**Files.** `patches/patch-summary-cite.js`, tests (property: `f(f(x)) === f(x)`; a streaming prefix is unchanged; a paragraph with `[1]` or `[1, 2]` is unchanged; two sources never get one), README, docs count, CLAUDE.md. Browser chunk: a reload, no restart.

---

## Phase C: the Discover route

All three edit `FILES.discoverRoute` and ship as one new patch, `patch-discover-stories`, built in three steps. Each step after the first is an upgrade `alts` entry from the step before (`ladder: ['fresh', 'V1', 'V2']`), because the text is in containers between steps.

**Now.** One Discover page load runs about 30 searches through SearXNG (5 English sites × 3-4 queries, 3-5 Greek sites × 2, two magazines) plus three feeds; only the Medium and Kleon feeds are cached. Switching topics waits for all of it, and the burst helps get engines suspended. Two thirds of magazine stories are dropped by the page for lack of a thumbnail, and Greek sites often carry the same agency story.

### 2. Cache: stale-while-revalidate, single flight

**Design.** Wrap the `"normal"` branch's producer, keyed by topic:

```
if("normal"===c){e=(await FANE_STORIES(globalThis,"discover:"+topic,async()=>{let e;let a=new Set;e=(…Vane's and the other patches' text, unchanged…).sort(()=>Math.random()-.5);return e})).slice().sort(()=>Math.random()-.5)}else e=…
```

- Two insertion targets: before `let a=new Set;` and after the existing `.sort(()=>Math.random()-.5)`. The other Discover patches' `to` strings stay whole substrings (they sit between the two insertion points), so all of them still count as applied. Both targets need a `marker`.
- `STORIES_CACHE(root, key, produce, {now, freshMs, staleMs})` (exported, tested) keeps one entry per key on `root.faneStories` with this life (CLAUDE.md, State machines):

| state | request | refresh ok (non-empty) | refresh empty or throws |
|---|---|---|---|
| empty | start refresh, await it | fresh | empty (return [], not cached) |
| fresh (< 10 min) | serve | - | - |
| stale (10-60 min) | serve, start refresh in background | fresh | stale (keep serving) |
| expired (> 60 min) | start refresh, await it | fresh | empty |

- Single flight: the entry holds the refresh promise, so concurrent requests share one producer run (the home widget and the page often load together). A throw clears the promise; an empty list is never cached, so a SearXNG hiccup is not served for ten minutes.
- The per-request shuffle stays outside the cache, so the page still varies.
- `KLEON` and `MEDIUM` keep their own caches (their text is in containers); a later cleanup can move them onto `STORIES_CACHE` with upgrade targets, not in this item.

**Measure.** `curl -w '%{time_total}'` on `/api/discover?topic=tech` cold, warm and stale (after 10 minutes): warm under 50 ms.

### 6. Repeated stories

**Design.** Stage 2 inside the cached producer: `DEDUPE_STORIES(items)` (pure, exported). Title key: lowercased, accents folded (`normalize('NFD')` minus marks; final sigma to sigma), punctuation dropped, words under 3 letters dropped. Two stories are the same when the word sets' Jaccard similarity is at least 0.6; keep the first with a thumbnail, else the first. O(n²) on about 150 items is fine. Runs before the shuffle, inside the cache, so once per refresh.

**Tests.** A Greek pair from two outlets differing in accents and one word; an English pair; two different stories sharing a name ("Apple" headlines) kept apart; idempotent.

### 5. Pictures for magazine stories

**Design.** Stage 3 inside the cached producer: `FILL_THUMBNAILS(items, {fetchImpl, allowHosts, limit, budgetMs})`. For stories without `thumbnail` whose host is in the route's own site list for the topic (`d.links`, plus the Greek table): fetch the page, read at most the first 64 KB, take `og:image` (then `twitter:image`), require `https:`. At most 12 pages per refresh, 4 at a time, the whole stage capped at 4 s (a story still without a picture is dropped by the page as before).

Security: this is the server fetching addresses that came from a search engine. The host allow-list (the route's own sites) is the trust boundary, with `redirect: 'manual'` (a redirect to another host is not followed) and no private hosts (`PRIVATE_ADDRESS` from `patches/lib/vane.js`). The image itself is loaded by the browser, as today.

Because it runs inside the cache, the cost is paid once per topic per refresh, mostly in the background (stale-while-revalidate).

**Tests.** A fake fetch: og:image found, twitter:image fallback, `http:` refused, a foreign host never fetched, a redirect not followed, the budget cuts a slow page, a story with a thumbnail never fetched.

**Files for phase C.** `patches/patch-discover-stories.js` (exports `STORIES_CACHE`, `DEDUPE_STORIES`, `FILL_THUMBNAILS`), `cli/test/patches.test.mjs` (chain with greek, medium, kleon, atlantic, newyorker, ellipsis on a fake route, applied twice), README, docs count, CLAUDE.md (and its State machines index). A server route: restart.

---

## Phase D: x_search by mode

### 3. x_search is a per-mode budget

**Now.** `patch-x-search` calls `searchX` in every mode, at most `FANE_X_MAX_CALLS` (2) per research. One call takes 40-90 s and about $0.15, which is most of a Speed answer's time.

**Design.** The budget becomes part of the mode's profile, the one place that knows what a mode spends:

- `cli/core/effort.mjs`: `xSearchCalls` per mode, `{ speed: 0, balanced: 2, quality: 2 }`; `resolveEffort` validates it; the test that keeps every phase table's keys equal to `MODES` covers it.
- `cli/write/xsearch.mjs`: `searchX({ …, mode })` takes the cap from `EFFORT[mode].xSearchCalls`; `FANE_X_MAX_CALLS` still overrides it for modes whose budget is not 0 (an environment variable can lower or raise cost, never turn Speed into a slow mode). Unknown or missing mode: the Balanced budget (today's behaviour).
- `patches/patch-x-search.js`: `CALL` passes `mode`. Where the mode is in scope inside the social tool is to be read from the bundle (in the web-search tool it is `a.mode` on the tool's config argument). The old `CALL` text becomes `CALL_V1`, an `alts` entry, so patched containers upgrade.

**Files.** `cli/core/effort.mjs`, `cli/write/xsearch.mjs`, `patches/patch-x-search.js`, `cli/test/effort.test.mjs`, `cli/test/x-search.test.mjs` (Speed makes no call and no key read; Balanced keeps two; env override ignored for Speed), CLAUDE.md (the x_search paragraph and effort.mjs paragraph). Restart (server chunk and the write folder).

---

## Phase E: report mode

### 9. Report mode

**Goal.** The nearest thing to Perplexity's Deep Research Fane can do well: a question split into sub-questions, each researched, then a structured, cited report. Not a fourth Vane mode (the mode menu, `patch-mode-icons`, `patch-quality-mode` and every phase table would grow); a request kind, like articles and posts.

**Design (in `cli/write`, no new layer).**

- **Detector** `isReportRequest` in `core/intent-article.mjs` (or `core/intent-report.mjs`, listed in `boundaries.test.mjs`): a request verb plus report/έκθεση/αναφορά, or "deep research …"/«σε βάθος». Excludes and is excluded by the article, post, code and brainstorm detectors; new rows in `intent-routing.test.mjs`, and `autoRoute` checks it before articles.
- **Format as a strategy.** `core/formats.mjs` gets `REPORT` (sections, word range per mode); the write pipeline takes `format: 'report'` the way it takes `'linkedin'`, with `REPORT_PHASES` per mode (the test keeps its keys equal to `MODES`). No second pipeline.
- **Phases.**
  1. `plan` (JSON role): 3-6 sub-questions plus what a good answer to each must contain.
  2. `research` fan-out: one Vane research per sub-question through the injected `retrieve`, at most 2 at a time (Vane's research is heavy and SearXNG engines get suspended), each with its own research panel in the web UI. Sources merged and renumbered by first appearance (`renumber`).
  3. `notes` map step: per sub-question, facts with `[n]` from its sources only (JSON role).
  4. `draft` reduce step: fixed sections (summary, one section per sub-question, a Markdown table of the key figures with each cell cited, "where sources disagree or are thin", and the sources list, code-built with `sourcesSection`).
  5. `factcheck` and `audit` as for articles, then one `revise` if the audit is under the floor; `trim` against the format's cap.
- **Cost.** Every call goes through `createRoleCaller`, so `FANE_MAX_COST` and the 499 stop apply; a fatal stop after the draft is `stopped` on an ok result (the degraded-finish rule). The fan-out is the expensive part: Quality's research rounds × sub-questions; the plan caps sub-questions per mode (Speed 3, Balanced 4, Quality 6).
- **Web UI.** The article hook handles it (format `report`); progress lines per phase (`createTurn`); tables are Markdown, which Vane's renderer draws. Follow-up edits: not in this item (named in the README).
- **CLI.** `vane --report "<question>"`, `-o` for a file; exit codes as `--article`.

**Tests.** Detector rows; plan normalizer (bad JSON, too many sub-questions, duplicates); the fan-out with a fake `retrieve` (concurrency 2 respected, one failing sub-question degrades the report instead of failing it); renumbering across sub-questions; the table cells keep citations through `renumber`; render round trip.

**Bench (paid, ask first).** `bench/reports.json`, three questions (one Greek), graded by `scripts/article-bench.mjs`' judge (claim support and audit) against a Quality `--article` on the same questions: a report must beat the article's support at no more than 3× its cost.

**Files.** `cli/core/formats.mjs`, `cli/core/intent-article.mjs` (or a new core file), `cli/write/pipeline.mjs`, `cli/write/prompts.mjs`, `cli/write/models.mjs`, `cli/write/vane-hook.mjs`, `cli/write/present.mjs`, `cli/runners.mjs`, `cli/vane.mjs` (usage, `autoRoute`), tests, README, CLAUDE.md. Restart (hook folder, via `node scripts/apply.mjs`).

---

## Not in this plan

- Source-reliability scoring: large, and there is no agreed way to judge it.
- Skipping Vane's classifier for summaries: only if item 1's timing shows the classifier dominates.
- Moving `KLEON`/`MEDIUM` onto the shared cache: a cleanup with upgrade targets, after phase C.
- Follow-up edits of reports.
- The phone layout of the summary page: unchecked, a check rather than a plan item; do it with item 4's live check (`resize_window` mobile).
