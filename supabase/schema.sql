-- Dynasty Lab accounts: one private row per account holding everything the app saves for you
-- (settings, linked Sleeper league, your rankings and the boards you pasted).
-- Run once in your Supabase project: SQL Editor -> New query -> paste -> Run.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row level security: an account can read and write only its own row; nobody else (including signed-out visitors)
-- can see it.
alter table public.user_data enable row level security;

drop policy if exists "read own data" on public.user_data;
drop policy if exists "add own data" on public.user_data;
drop policy if exists "change own data" on public.user_data;
drop policy if exists "delete own data" on public.user_data;

create policy "read own data" on public.user_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "add own data" on public.user_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "change own data" on public.user_data for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "delete own data" on public.user_data for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.user_data to authenticated;
