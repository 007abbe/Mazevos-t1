# Mazevo
Trading journal + AI agent platform. Migrating from FlowJournal (single-file HTML). Data stays in Supabase, untouched.

## Stack
Vanilla JS + Vite. Supabase (auth, Postgres, Edge Functions). Deployed to GitHub Pages via Actions.

## Structure
- src/journal/ — trade logging, stats, screenshots
- src/agents/<name>/ — one folder per agent, each exports the agent contract from index.js
- src/domain/ — trading logic (SPM, regime router, vol), agent-agnostic, no UI
- src/lib/ — supabase client, auth
- supabase/functions/ — Edge Functions

## Agents
- DOM — post-trade analyst, two-layer deterministic + LLM
- Reggie — macro reader. One option so far: **mac**, the systematic macro reader
  (FRED ingest, factor states with hysteresis, bull/bear bar, daily snapshot).
  Replaced Gnosis, which was built but never used.
- Finski — pre-market brief, model-risk rules, economic calendar

## mac
- Compute lives in src/domain/mac/ and is pure and node-tested. The
  `mac-fred` Edge Function is a thin FRED proxy holding the API key — it decides
  nothing, so there is never a second copy of a threshold.
- Needs `FRED_API_KEY` set as a Supabase secret.
- The Finski MACRO paragraph is written by src/domain/mac/narrative.js and
  spliced in by `formatBrief`. It is never sent to the model: Finski's prompt
  forbids direction and mac is directional, and this is what keeps both true.
- Runs once a day on app load (`runDailyMac` in agents/reggie/index.js). Schedule
  logic is in mac/auto.js and takes every dependency by argument — anything that
  imports src/lib/supabase.js cannot be run by `node --test`, because that file
  reads `import.meta.env` at module load.
- L2 day typing reads the ForexFactory feed Finski already fetches. **That feed
  only ever holds the current week** (nextweek/lastweek/monthly all 404), so the
  event horizon dies on Friday. Every result carries `horizon_sessions` and
  `horizon_truncated`; never render an event list without them, or a two-session
  read looks like a quiet week.
- The weekly feed has **no `actual` field**, but the ForexFactory calendar
  *page* does. `scripts/fetch-ism.mjs` scrapes it in the calendar Action into
  `public/data/ism_pmi.json`; the feed's `previous` still backfills older months
  one release late. **There is no manual entry box** — `harvestHealth` turns the
  panel red if the scrape stops, and a bad print is corrected by editing the
  committed `ism_pmi.json`, which survives where a typed value did not.
  Precedence (hand-edited > scraped actual > feed `previous`) lives in one
  place, `mergeIsmHistory`. Never write a `forecast` into the PMI history.
- The scraper must use **curl, not Node's `fetch`** — ForexFactory answers 403
  to Node whatever headers it sends, and 200 to curl. Parsing stays pure and
  node-tested in `src/domain/mac/ff-actuals.js`; only the fetch is shelled out.
  Cap requests per run (`MAX_REQUESTS`): a burst gets refused, and the first
  request of a run is the month that carries a new print.

## Staleness budgets
- `budgetDays` is measured against the **observation date, not the release
  date**, and for anything slower than daily those are far apart. A monthly
  print is dated the month it *describes* and published 4-8 weeks later. Three
  budgets were originally set as if the two were the same and were literally
  unsatisfiable — GDPNow's youngest possible observation is 25 days old, against
  what was a 21-day budget, so it was stale on 100% of sessions and **F1 Growth
  sat carried at 0 from the day it shipped**. Budgets are now set near the p90 of
  the measured age distribution; the table is in `factors.js`.
- A factor holds only when the input it **cannot work without** is gone. F2 had
  this right (core PCE alone keeps it alive); F1 did not, and any stale input
  killed it. A stale secondary input costs its vote, not the factor — and is
  propagated into `data_health.stale` rather than swallowed.

## Backtest / validation
- `node --env-file=.env scripts/backtest.mjs` replays mac over history. It calls
  the real `buildSnapshot` — there is no second model — and chains snapshots so
  hysteresis accumulates. Needs `FRED_API_KEY` in .env for the first run only.
- Point-in-time is enforced three ways: ALFRED vintages, an embargo on anything
  dated the session itself (mac runs pre-market), and ISM gated on
  `release_date`. `src/domain/mac/vintage.js` owns all three.
- **FRED silently truncates an over-wide vintage request** to the most recent
  ~800 vintage dates, with no error. Fetch in 2-year realtime slices. The
  coverage guard in `backtest.mjs` exists because this bug already invalidated
  one full result.
- **FRED only holds the ICE BofA credit series (BAMLH0A0HYM2, BAMLC0A0CM) for a
  rolling 3 years** — licensing, not a bug. F5 cannot be replayed before
  2023-09-11, so any longer backtest is a 6-factor mac.
- Status as of 2026-09-09: **F7 vol is validated** — dispersion scales
  monotonically (calm 91bps sd → hostile 228bps) in-sample and out. **The L1
  directional bar is not** — bull-minus-bear spread straddles zero in every arm,
  and the two time-halves have opposite signs. Do not size off direction.

## Environment (the part with a mechanism behind it)
- `src/domain/mac/environment.js` reads two **levels**, not changes: the 10y
  real yield (DFII10) against ~0.5%/~1.5%, and the 13-week change in net
  liquidity (WALCL − TGA − RRP) against ±$100bn. Corners only — headwind,
  tailwind, everything else `mixed`.
- Every other factor reads *changes*, which is why they are reactive. Measured:
  F7's `hostile` arrives on average **253bps after** the drawdown it reacts to.
- Thresholds are anchored on r* estimates and the observed liquidity
  distribution — **never fit to returns**. Fitting them would make this a signal,
  which it must not be. It cannot be validated statistically either: the unit is
  the environment and 10 years holds ~5 of them. The test is mechanism plus
  descriptive accuracy, and next the journal (expectancy of longs vs shorts by
  environment), which accrues on trade count.
- Standing codes must **never be 0**: `memory()` starts state at 0 and `confirm`
  short-circuits when candidate equals state, so a 0 code can never publish.
  Encoding `mixed` as 0 cost 3.5 years of false "not enough data".
- 10-session confirmation, ~20 label changes per decade. If it moves more often
  than that the thresholds are wrong.

## VXN (Finski)
- **VXN, not VIX.** NQ is the Nasdaq-100 and VXN is its volatility index; VIX is
  the S&P's. The thresholds in model-risk.js were re-derived at matching
  percentiles rather than reused — VXN's median is 19.4 against VIX's 16.2, so a
  straight swap puts an ordinary day in the elevated band. VIX 20→p75→VXN 24,
  VIX 28→p94→VXN 33, VIX +15% d/d→p96→VXN +12%. VVIX has no Nasdaq counterpart
  and is unchanged.
- VXN now / prev / VVIX are auto-filled from the `market-quote` Edge Function.
  **Cboe first** (`cdn.cboe.com/api/global/delayed_quotes/quotes/_VXN.json`) —
  Cboe computes these indices, everyone else including TradingView redistributes
  them — with Yahoo as fallback. The response is tagged with which answered.
  No API key; it exists only because neither sends CORS headers. Symbol
  allowlist is the security boundary.
- **Round to 2dp.** Yahoo returns float32 widened to double, so 15.72 arrives as
  15.720000267028809 and renders verbatim in a number field.
- Stored briefs before 2026-09-09 carry `vix`; newer ones carry `vxn`. Not
  migrated — a brief is the record of what was in front of you that morning.
- **Never use Yahoo's `chartPreviousClose`** — it is the close before the
  requested *range*, six sessions back on a 5d request. Previous close is derived
  in `src/domain/quote.js` from the last session strictly before today ET, which
  also skips today's partial bar during the session.
- Before 09:30 ET the index is not disseminated, so "now" is reported as the
  previous close and labelled that way rather than passed off as live.
- Fields stay editable and are never overwritten once typed: Finski refuses to
  run without a VIX, so a failed quote must leave a box you can fill.

## Units
- FRED publishes **WALCL and WTREGEN in millions**, RRPONTSYD in billions. Both
  of the first two need `MILLIONS_TO_BN`. Only WALCL was scaled originally, so
  net liquidity computed as −961,198bn instead of +5,769bn and F4 was really
  reading the inverse of the Treasury cash balance, amplified 1000×, with 434
  spurious −2 readings. Check `units_short` on FRED for any new series rather
  than copying a neighbour.

## Rules (mac-specific)
- Trades carry `regime_bias`, `regime_conviction`, `vol_regime`, `macro_day_type`,
  stamped once at log time by `stampRegime`. Never restamp on edit — the column
  records the regime the trade was *taken* under. `macro_day_type` is prefixed
  because `trades.day_type` is the manually tagged one.

## Journal models
- Four: STDV, MM, SPM-R and `x`. The model decides which panel the form renders
  and which columns get written, and each model's own setup column is named
  once in `SETUP_COLUMNS` / `modelSetup` — the journal list, DOM's picker and
  DOM's report all read it from there, because each used to carry its own copy
  of the same ternary and a fifth model meant finding three call sites.
- A tagged model is not asked every shared question. `tagged` gates target, BE,
  gamma and rules; `regimed` (STDV, MM) gates regime; `majored` (STDV, SPM-R)
  gates major regime and news. Writing any of those from `tagged` saves an
  answer the trader was never shown.
- SPM-R's grade is A/B/C/F in **`spm_grade`**, not `setup_type`. STDV's A/B/C
  are three different setups; these are one setup's quality score, and a shared
  column would make every by-setup statistic average the two together.
- **The two reworded rules kept their stored values.** "No away-stack" now
  reads *No entry trigger* and "Size over cap" reads *Too much risk*, but
  `rule_broken` still holds `no_away_stack` and `size_over_cap`. The tally in
  trade-stats.js counts by value, so a second spelling would split one rule
  into two buckets at the cutover date. Labels are what you read, values are
  what the history is written in — and the pills render the label, which they
  did not before (they printed the raw value and the `label` field was dead).
- `rev_zone` stores the zone typed into its `other` box **as a zone**, not as a
  flag plus a note, the same way `target` takes a hand-typed level. Any stored
  value that is not in `REV_ZONES` is therefore the typed one, which is how the
  form puts it back in the box when you edit the trade.
- **The discretion audit is STDV and MM only.** SPM-R hides the block and writes
  `mech_trigger`, `discretionary_act` and the four `mech_*` prices null, on the
  same rule the model tags follow: a trade must not carry an answer the form
  did not put in front of you. Conviction is the exception — it is a property
  of the decision, not of the model, so SPM-R keeps it in its own tag box. Two
  ids (`CONVICTION_IDS`), because the hidden audit is still in the DOM and one
  shared id would put two conviction boxes on the page.
- The journal's discretion-delta tile (`src/journal/index.js:36`) therefore
  keeps accruing from STDV and MM only. SPM-R rows are absent from it by
  design, not by omission.
- A trade carries up to 4 screenshots in `images`; `image` still holds the
  first, so FlowJournal and every pre-`images` row still resolve one and
  nothing needed backfilling. Neither query that lists trades selects either.

## Journal filters
- The filter bar is **sticky** — it survives the remount a save causes and it
  survives the session, in localStorage, per scope. Only the Clear button
  resets it.
- That buys one failure mode: a narrowing you forgot you set looks exactly like
  an empty journal. Two things answer it, and neither is decoration. The Clear
  button is rendered only while something is active, and `sanitiseFilters`
  drops any stored value the current vocabulary no longer knows instead of
  applying it — a renamed status would otherwise match nothing and read as lost
  data. Any new filter must be added to `FILTER_KEYS` and `ALLOWED` together.
- `sort` is not a filter. It is remembered, but it does not light the Clear
  button and Clear does not reset it — a lit button over a full table teaches
  you to ignore the one control that explains an empty one.
- The **account** filter is still owned by `accounts.js`, not `filter-memory.js`,
  because restoring it needs the list of accounts that still exist. That split
  is why `rememberFilters` drops `account` on the way in.
- Filtering by model reads `tradeModel`, which resolves null to STDV. Every row
  logged before the `model` column existed is STDV, and a filter that missed
  them would hide the oldest half of the journal from its own model.

## Rules
- Never modify the Supabase schema without asking. Existing trade data is production.
- Verify each migration step in the browser before moving on.
- Domain logic lives in src/domain/, not inside agent prompt strings.
