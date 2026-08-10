-- Second trading model (MM) alongside STDV.
--
-- Every trade logged so far belongs to the STDV model — the form only ever
-- offered STDV's metrics. MM shares some of them (regime, gamma regime, target,
-- BE, rules broken) and drops others (setup A/B/C, band touched), so the model a
-- trade belongs to has to be stored: without it, an MM trade and an STDV trade
-- are indistinguishable rows with different columns filled in.
--
-- Additive only. No existing column changes type, and nothing is backfilled —
-- `model` is null on every existing row, which the form reads as STDV (see
-- src/journal/form.js). Backfilling would rewrite `updated_at` on production
-- rows for no gain.

begin;

-- 'STDV' | 'x' | 'MM'. Null means a trade logged before this column existed,
-- which is STDV by definition. 'x' is the model-less mode: notes and a
-- screenshot, no model tags at all.
alter table public.trades
  add column if not exists model text;

-- MM's setup, kept apart from setup_type so the STDV A/B/C vocabulary stays
-- exactly what FlowJournal wrote. One column per model, never both populated.
alter table public.trades
  add column if not exists mm_setup text;

-- MM logs the entry it actually got, not just the stop and the exit.
alter table public.trades
  add column if not exists entry_price numeric;

commit;
