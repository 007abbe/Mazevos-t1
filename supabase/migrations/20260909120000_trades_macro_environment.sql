-- The macro *environment*, stamped onto every trade at log time.
--
-- Companion to 20260908120000_trades_macro_regime.sql, and added for a reason
-- that migration could not have known: the bar those columns record did not
-- survive validation. Replayed over 2,582 sessions (2016-2026) with
-- point-in-time data, the bull/bear lean separated nothing — bull-minus-bear
-- came to -2.3bps [-12.3, +8.0], in-sample and out-of-sample disagreed in sign,
-- and no individual factor cleared either. The one thing that did separate was
-- the vol regime, on dispersion rather than direction.
--
-- So this is not another lean. It is the standing condition, from the two
-- channels macro reaches a long-duration index through:
--
--   the *level* of the 10-year real yield  — the discount rate
--   the quarterly change in net liquidity  — the marginal bid
--
-- Both are levels, not moves, which is the whole distinction. mac's other
-- factors read changes, and a model built on changes can only report what has
-- already happened — measurably so: the `hostile` flag arrives on average
-- 253bps *after* the drawdown it is reacting to.
--
-- Why stamp something with no forward test behind it? Because it cannot get one
-- from history. The unit of analysis is the environment and ten years holds
-- four or five, so statistical validation is permanently out of reach that way.
-- What *is* reachable is the journal: expectancy of long setups versus short
-- setups, by environment, accumulating on trade count rather than calendar
-- days. That test needs the column to exist first, and like the regime columns
-- it cannot be backfilled — `macro_snapshots` only starts the day mac did.
--
-- Nothing acts on these. GATING_ENABLED is still false and the panel says so.
-- Sizing off the environment while measuring whether the environment works
-- would measure compliance with it, which is the trap validation.js already
-- names.
--
-- Additive only. Nullable, no defaults, nothing backfilled: null means "logged
-- before the environment existed", which is a real and distinct state. A
-- backfill would rewrite `updated_at`, and `updated_at` is FlowJournal's merge
-- key.

begin;

-- 'headwind' | 'mixed' | 'tailwind'. Only the corners are named: headwind is
-- restrictive real rates *and* draining liquidity, tailwind is accommodative
-- *and* expanding. Everything else is 'mixed', which is the honest reading when
-- the two channels disagree rather than a hedge. Text, not an enum — the
-- thresholds behind it are anchored on r* estimates rather than on anything
-- fitted, and revising them should not require a migration.
alter table public.trades
  add column if not exists macro_environment text;

-- 'accommodative' | 'neutral' | 'restrictive', from the *level* of DFII10
-- against ~0.5% and ~1.5%. Stored separately from the combined label because
-- the two channels can and do diverge, and which one was leaning is exactly
-- what the journal test will want to cut by.
alter table public.trades
  add column if not exists real_rate_stance text;

-- 'draining' | 'flat' | 'expanding', from the 13-week change in
-- WALCL - TGA - RRP against ±$100bn.
alter table public.trades
  add column if not exists liquidity_stance text;

-- Grouped by in the same breath as direction, so worth an index together.
-- Partial for the same reason as the regime index: rows logged before this
-- existed are null across the board and would otherwise dominate it.
create index if not exists trades_macro_environment_idx
  on public.trades (user_id, macro_environment)
  where macro_environment is not null;

commit;
