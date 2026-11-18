-- Bibliothèque partagée de l'atelier liturgique.
-- Les policies reproduisent le fonctionnement décrit par le site de référence :
-- tout compte authentifié de ce projet peut lire et modifier les travaux du groupe.

create table if not exists public.liturgical_works (
  id text primary key,
  title text not null,
  work jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.liturgical_works enable row level security;

drop policy if exists "Authenticated readers can manage group works" on public.liturgical_works;
create policy "Authenticated readers can manage group works"
  on public.liturgical_works
  for all
  to authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on public.liturgical_works to authenticated;
