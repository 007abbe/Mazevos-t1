-- Account goals and prop-firm rules.
--
-- An evaluation or funded account is a set of rules: a starting balance, a
-- profit target, a drawdown that may trail, maybe a daily loss limit and a
-- consistency rule. The Accounts panel computes where each account stands
-- against them from the trades already on it (src/domain/account-goals.js), so
-- these columns hold only the rules, never a derived number.
--
-- Additive only. Every column is nullable and nothing is backfilled: an account
-- with no rules reads exactly as it did before, and `trades` is not touched.

begin;

alter table public.accounts
  -- Free text: 'Lucid', 'Topstep', or anything typed. Presets live in the UI.
  add column if not exists firm text,
  -- Starting balance. Balance is this plus the account's net P&L.
  add column if not exists account_size numeric,
  add column if not exists profit_target numeric,
  -- The loss allowance, in dollars, and how its floor moves:
  -- 'eod' trails the highest end-of-day balance, 'intraday' trails the highest
  -- balance after any trade, 'static' never moves.
  add column if not exists max_drawdown numeric,
  add column if not exists drawdown_type text,
  -- The balance at which a trailing floor stops trailing. Null trails forever.
  add column if not exists drawdown_lock numeric,
  add column if not exists daily_loss_limit numeric,
  -- Best day as a maximum percent of total profit, e.g. 50.
  add column if not exists consistency_pct numeric,
  add column if not exists min_days integer,
  -- Personal goal, separate from any firm rule.
  add column if not exists monthly_goal numeric,
  -- Lifecycle the trader sets by hand: 'active' | 'passed' | 'failed' | 'retired'.
  -- Null is active. Whether the rules are currently met is computed, not stored.
  add column if not exists status text;

commit;
