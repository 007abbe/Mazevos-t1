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
- The feed has **no `actual` field**. ISM is harvested from the next release's
  `previous` (so: correct, one month late) and the manual box covers the current
  print. Never write a `forecast` into the PMI history.

## Rules (mac-specific)
- Trades carry `regime_bias`, `regime_conviction`, `vol_regime`, `macro_day_type`,
  stamped once at log time by `stampRegime`. Never restamp on edit — the column
  records the regime the trade was *taken* under. `macro_day_type` is prefixed
  because `trades.day_type` is the manually tagged one.

## Rules
- Never modify the Supabase schema without asking. Existing trade data is production.
- Verify each migration step in the browser before moving on.
- Domain logic lives in src/domain/, not inside agent prompt strings.
