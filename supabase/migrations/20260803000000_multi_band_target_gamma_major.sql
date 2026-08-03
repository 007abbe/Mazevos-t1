-- Widen band_touched and target to arrays, add gamma_regime and major_regime.
--
-- band_touched and target were single-value text columns, matching FlowJournal.
-- A trade can touch more than one band and aim at more than one target, so both
-- become text[] — the same shape rule_broken already has.
--
-- FlowJournal (github.com/007abbe/trading-journal) reads and writes both as
-- scalars. After this runs it can no longer write this table; it is
-- reference-only. Mazevo is the sole writer.
--
-- Existing values convert to single-element arrays; nulls and empty strings
-- become empty arrays, so nothing is lost and no row needs backfilling.

begin;

alter table public.trades
  alter column band_touched type text[]
    using (
      case
        when band_touched is null or band_touched = '' then '{}'::text[]
        else array[band_touched]
      end
    ),
  alter column band_touched set default '{}'::text[];

alter table public.trades
  alter column target type text[]
    using (
      case
        when target is null or target = '' then '{}'::text[]
        else array[target]
      end
    ),
  alter column target set default '{}'::text[];

-- Gamma regime: 'positive' | 'negative'. Null means untagged.
alter table public.trades
  add column if not exists gamma_regime text;

-- Major regime: yes/no. Nullable on purpose — null is "not answered", which is
-- what every trade logged before this column existed actually is, and is
-- distinct from an explicit "no".
alter table public.trades
  add column if not exists major_regime boolean;

commit;
