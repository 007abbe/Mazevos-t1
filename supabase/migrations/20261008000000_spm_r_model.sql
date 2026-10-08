-- The SPM-R model, and more than one screenshot per trade.
--
-- Additive only: every column here is new and nullable (or an empty array), so
-- nothing existing is read differently and no row needs backfilling. Nothing is
-- renamed either — the two rules-broken labels that changed wording in this
-- release kept their stored values precisely so that this migration would not
-- have to rewrite `rule_broken` on production trades.

begin;

-- SPM-R's grade: A/B/C/F. Its own column rather than `setup_type`, which holds
-- STDV's three *setups* — one column carrying both would make every by-setup
-- statistic silently average a setup together with a quality score. Same
-- reasoning that gave MM `mm_setup`.
alter table public.trades
  add column if not exists spm_grade text;

-- SPM-R's tier: T1-T5. One per trade.
alter table public.trades
  add column if not exists tier text;

-- What got the trade filled. An array because a fill can be more than one of
-- them at once (absorption into an initiation, say).
alter table public.trades
  add column if not exists entry_trigger text[] default '{}'::text[];

-- What it was reverting from. An array for the same reason `target` is one: a
-- level worth trading against is usually several things at once. Holds free
-- text as well as the suggested zones — the zone named in the "other" box is
-- stored as itself, not as a flag plus a note.
alter table public.trades
  add column if not exists rev_zone text[] default '{}'::text[];

-- Up to four screenshots, same base64 data-URI format as `image`.
--
-- `image` is NOT dropped and NOT emptied: the app keeps writing the first
-- screenshot to it, so FlowJournal and every existing row still resolve a
-- screenshot from the column they already read. Rows written before this
-- migration therefore need no backfill — `fromRow` widens a lone `image` into
-- a one-element list when `images` is empty.
alter table public.trades
  add column if not exists images text[] default '{}'::text[];

commit;
