-- Sauvegarde en ligne : une ligne par compte, accessible à son seul propriétaire (appliquée le 2026-09-29)
create table public.saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data text not null,
  version text,
  updated_at timestamptz not null default now()
);
alter table public.saves enable row level security;
create policy "saves_select_own" on public.saves for select to authenticated using ((select auth.uid()) = user_id);
create policy "saves_insert_own" on public.saves for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "saves_update_own" on public.saves for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "saves_delete_own" on public.saves for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.saves from anon;
grant select, insert, update, delete on public.saves to authenticated;
