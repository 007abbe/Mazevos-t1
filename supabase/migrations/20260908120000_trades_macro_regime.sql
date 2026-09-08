-- The macro regime, stamped onto every trade at log time.
--
-- This is the join Phase 4 lives on. The validation plan asks whether SPM's
-- expectancy in `hostile` is worse than in `calm`, and whether the bull/bear
-- bar separates MM's continuation trades. Neither question can be asked of a
-- trade that was logged without the regime beside it — and it cannot be
-- backfilled honestly either, because `macro_snapshots` only starts the day mac
-- did. Every session traded before these columns exist is a session Phase 4 can
-- never measure, which is why they land now rather than with the report.
--
-- A note on naming. `trades.day_type` is already taken by the *manually tagged*
-- day type ('Trend Day' and friends, src/domain/trade-vocab.js), which
-- `yesterdayContext` reads for the regime-persistence rule. mac's day type is a
-- different thing measured a different way, so it gets its own column rather
-- than overloading one that already carries meaning. Same reason `regime` and
-- `gamma_regime` are left alone.
--
-- Deliberately not stored: `bull_pct`. It is one join away on
-- (user_id, date) → macro_snapshots, and duplicating a number that phase 4 is
-- explicitly going to recalibrate would leave stale copies scattered across
-- trade rows after the first refit.
--
-- Additive only, following the migrations before it. Every column is nullable
-- with no default and nothing is backfilled: null means "logged before mac", a
-- real and distinct state from any regime label. Backfilling would rewrite
-- `updated_at` on production rows, and `updated_at` is FlowJournal's merge key.

begin;

-- The bar label at log time: 'strong_bear' | 'bear' | 'leaning_bear' |
-- 'neutral' | 'leaning_bull' | 'bull' | 'strong_bull'. Text rather than an enum
-- for the same reason `type` on accounts is text — phase 4 may well recut these
-- buckets, and an enum would turn that into a migration.
alter table public.trades
  add column if not exists regime_bias text;

-- 'low' | 'medium' | 'high'. Stored separately from the label because the same
-- lean means something different at 2/6 agreement than at 5/6, and the whole
-- point of the validation is to find out how much different.
alter table public.trades
  add column if not exists regime_conviction text;

-- 'calm' | 'elevated' | 'hostile'. The first thing phase 4 tests, and the one
-- that already gates size today.
alter table public.trades
  add column if not exists vol_regime text;

-- mac's L2 day type: 'normal' | 'tier1_event' | 'tier2_event' | 'auction_day' |
-- 'quarter_end'. Prefixed to keep it clear of `day_type` above.
alter table public.trades
  add column if not exists macro_day_type text;

-- Phase 4 groups by these, so they are worth an index together. Partial: rows
-- logged before mac are null across the board and would otherwise dominate it.
create index if not exists trades_macro_regime_idx
  on public.trades (user_id, vol_regime, regime_bias)
  where vol_regime is not null;

commit;
