-- Trading accounts, and the account a trade was taken on.
--
-- A trade currently says nothing about where it was executed, so a funded
-- account's P&L and a demo account's P&L land in the same tiles. This adds the
-- account as a first-class row (it carries a type, a name and a note, none of
-- which fit in a text column on `trades`) and points each trade at one.
--
-- Additive only. No existing column changes type and nothing is backfilled:
-- `account_id` is null on all 54 existing rows, which the UI reads as
-- "unassigned" and shows under "All accounts". Backfilling would rewrite
-- `updated_at` on production rows; assigning them is a deliberate action in the
-- Accounts UI instead.

begin;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'Live' | 'Demo' | 'Evaluation' | 'Funded'. Text rather than an enum: the
  -- set is a UI vocabulary (src/domain/account-vocab.js), and adding a type
  -- should not need a migration.
  type text not null,
  name text not null,
  -- Optional, shown in the Accounts UI only.
  note text,
  created_at timestamptz not null default now()
);

-- Every read is "this user's accounts", ordered for display.
create index if not exists accounts_user_id_idx on public.accounts (user_id, created_at);

alter table public.accounts enable row level security;

-- One policy per verb, each scoped to the owner. `with check` on insert and
-- update stops a client handing in someone else's user_id.
drop policy if exists "accounts are readable by owner" on public.accounts;
create policy "accounts are readable by owner"
  on public.accounts for select
  using (auth.uid() = user_id);

drop policy if exists "accounts are insertable by owner" on public.accounts;
create policy "accounts are insertable by owner"
  on public.accounts for insert
  with check (auth.uid() = user_id);

drop policy if exists "accounts are updatable by owner" on public.accounts;
create policy "accounts are updatable by owner"
  on public.accounts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "accounts are deletable by owner" on public.accounts;
create policy "accounts are deletable by owner"
  on public.accounts for delete
  using (auth.uid() = user_id);

-- `on delete set null` is the whole delete policy for accounts: removing a
-- blown evaluation must never remove the trades logged on it. Those trades stay
-- in the journal, unassigned, exactly as they were before an account existed.
alter table public.trades
  add column if not exists account_id uuid
    references public.accounts (id) on delete set null;

-- The journal filters by account client-side over the rows it already loaded,
-- but the trade-count-per-account query in the Accounts UI does hit this.
create index if not exists trades_account_id_idx on public.trades (account_id);

commit;
