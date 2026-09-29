-- Classement au temps de jeu (appliquée le 2026-09-29)
create table public.leaderboard (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pseudo text not null,
  seconds integer not null check (seconds > 0),
  version text,
  finished_at timestamptz not null default now()
);
create index leaderboard_seconds_idx on public.leaderboard (seconds, finished_at);
alter table public.leaderboard enable row level security;

-- lecture publique (classement visible sans compte) ; aucune écriture directe : tout passe par submit_time
create policy "leaderboard_read_all" on public.leaderboard for select to anon, authenticated using (true);
revoke all on public.leaderboard from anon, authenticated;
grant select on public.leaderboard to anon, authenticated;

-- security definer : le pseudo est lu dans le compte (pas fourni par le client) et seul le meilleur temps est gardé.
-- Plancher à 30 min : atteindre l'étape 6 prend déjà ~2 h de jeu réel, en dessous c'est forcément truqué.
create function public.submit_time(p_seconds integer, p_version text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  nm text;
  best integer;
begin
  if uid is null then raise exception 'non connecté'; end if;
  if p_seconds is null or p_seconds < 1800 or p_seconds > 31536000 then raise exception 'temps invalide'; end if;
  select coalesce(u.raw_user_meta_data->>'pseudo', 'joueur') into nm from auth.users u where u.id = uid;
  insert into public.leaderboard as l (user_id, pseudo, seconds, version, finished_at)
    values (uid, nm, p_seconds, left(p_version, 20), now())
  on conflict (user_id) do update
    set seconds = excluded.seconds, pseudo = excluded.pseudo, version = excluded.version, finished_at = now()
    where excluded.seconds < l.seconds;
  select l.seconds into best from public.leaderboard l where l.user_id = uid;
  return best;
end;
$$;
revoke execute on function public.submit_time(integer, text) from public, anon;
grant execute on function public.submit_time(integer, text) to authenticated;
