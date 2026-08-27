-- Backtest journalling, veto rows, and the discretion audit.
--
-- Three additions that share one table because they describe the same row from
-- different angles:
--
--   1. Backtest accounts. No column here — a backtest account is an `accounts`
--      row whose `type` is 'Backtest' (src/domain/account-vocab.js), and `type`
--      is already free text precisely so a new one costs no migration. Trades on
--      a backtest account are hidden from the live journal and the Statistics
--      view, and shown in the Backtest journal instead.
--
--   2. Veto rows. A trade you did *not* take, logged so the reasoning survives.
--      It carries a thesis, a screenshot and every model tag a real trade does,
--      but no P&L, no risk and no status — so it must never reach a win rate or
--      a trade count. `kind` is what keeps it out.
--
--   3. The discretion audit. Was there a strict mechanical trigger, what did you
--      do differently, and what would the mechanical version have returned. The
--      point of these columns is one number: mean actual R minus mean
--      mech_counterfactual_r over rows where mech_trigger = 'yes'
--      (src/domain/discretion.js).
--
-- Additive only, following the two migrations before it. No existing column
-- changes type and nothing is backfilled: `kind` is null on all existing rows,
-- which every reader treats as 'trade' — the only thing the form could log
-- before this. Backfilling would rewrite `updated_at` on production rows for no
-- gain, and `updated_at` is FlowJournal's merge key.

begin;

-- 'trade' | 'veto'. Null means a row written before this column existed, which
-- is a real trade by definition.
alter table public.trades
  add column if not exists kind text;

-- Veto only: what the trade would have done had it been taken. 'win' | 'loss' |
-- 'breakeven' | 'unclear'. Text, not a number — a veto has no fill, so there is
-- no honest P&L to record, and pretending otherwise is exactly what this column
-- exists to avoid.
alter table public.trades
  add column if not exists veto_outcome text;

-- 1-10, how strongly you believed the idea at the time. Null is "not answered",
-- distinct from a 1. smallint because the range is fixed and small.
alter table public.trades
  add column if not exists conviction smallint;

-- 'yes' | 'no' | 'partial' — would a strict mechanical SPM/MM have fired here?
-- The gate on the discretion delta: only 'yes' rows have a mechanical baseline
-- to be measured against.
alter table public.trades
  add column if not exists mech_trigger text;

-- What you did that the mechanical version would not have. Postgres text[] like
-- rule_broken and target, values from src/domain/veto-vocab.js. Multi-valued:
-- shifting the entry and cutting early are two separate acts on one trade.
alter table public.trades
  add column if not exists discretionary_act text[] default '{}'::text[];

-- The R the mechanical version would have returned on this idea. Signed, and
-- deliberately not derived from mech_entry/stop/exit: those four are the prices
-- you read off the chart, this is the number you are willing to be judged on.
alter table public.trades
  add column if not exists mech_counterfactual_r numeric;

-- The mechanical version's prices, as levels. Kept beside the discretionary
-- entry_price/planned_stop/actual_exit rather than replacing them: the whole
-- question is how far the two sets diverged.
alter table public.trades
  add column if not exists mech_entry numeric;

alter table public.trades
  add column if not exists mech_stop numeric;

alter table public.trades
  add column if not exists mech_target numeric;

alter table public.trades
  add column if not exists mech_exit numeric;

-- The journal filters kind client-side over rows it already loaded, but the
-- index keeps a future "count the vetoes" query honest and costs one small btree
-- on a column that is null for most rows.
create index if not exists trades_kind_idx on public.trades (kind);

commit;
