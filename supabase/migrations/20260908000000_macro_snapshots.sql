-- mac daily macro snapshots.
--
-- One row per user per trading date, holding the whole snapshot object
-- (src/domain/mac/snapshot.js). Additive: no existing table is touched, and
-- nothing here reads or writes `trades`.
--
-- Why jsonb rather than a column per factor. The snapshot is versioned
-- (`version: "mac-0.1"`) and its shape will change as factors are added and
-- thresholds are recalibrated in phase 4. A column-per-field schema would need
-- a migration for each of those, and — worse — would silently rewrite history:
-- a snapshot written under v0.1 has to keep reading back exactly as it was
-- computed, because the whole validation plan is a join between what the regime
-- said on a date and what the trades did. jsonb keeps old rows intact and lets
-- the reader branch on `version`.
--
-- Why the primary key is (user_id, date) rather than the spec's bare `date`.
-- RLS needs an owner column to scope on, matching `accounts` and
-- `finski_briefs`. The date alone stays unique per user, which is what the
-- carry-forward logic requires: yesterday's row is the only history a recompute
-- reads, and there must be exactly one of it.

begin;

create table if not exists public.macro_snapshots (
  user_id uuid not null references auth.users on delete cascade,
  -- The New York trading date, not the UTC one. A snapshot computed at 11:00
  -- CET belongs to that day's NY session; dating it by UTC would be correct
  -- until it isn't, in the evening, which is when briefs get written.
  date date not null,
  snapshot jsonb not null,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, date)
);

-- The card reads the last ten sessions for the sparkline and the recompute
-- reads exactly one row (yesterday's), both newest-first by owner.
create index if not exists macro_snapshots_user_date_idx
  on public.macro_snapshots (user_id, date desc);

alter table public.macro_snapshots enable row level security;

-- One policy per verb, each scoped to the owner. `with check` on insert and
-- update so a row cannot be written into someone else's history.
drop policy if exists "macro snapshots are readable by owner" on public.macro_snapshots;
create policy "macro snapshots are readable by owner"
  on public.macro_snapshots for select
  using (auth.uid() = user_id);

drop policy if exists "macro snapshots are insertable by owner" on public.macro_snapshots;
create policy "macro snapshots are insertable by owner"
  on public.macro_snapshots for insert
  with check (auth.uid() = user_id);

-- Recomputing the same day must overwrite rather than accumulate: the snapshot
-- is a statement about a date, and two of them for one date would make the
-- carry-forward read ambiguous.
drop policy if exists "macro snapshots are updatable by owner" on public.macro_snapshots;
create policy "macro snapshots are updatable by owner"
  on public.macro_snapshots for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "macro snapshots are deletable by owner" on public.macro_snapshots;
create policy "macro snapshots are deletable by owner"
  on public.macro_snapshots for delete
  using (auth.uid() = user_id);

commit;
