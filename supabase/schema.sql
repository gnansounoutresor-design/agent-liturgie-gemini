-- Assistant liturgique — profils privés et bibliothèque du groupe.
-- Exécuter avec le SQL Editor Supabase. Les clés service_role ne sont jamais
-- nécessaires dans ce script ni dans le navigateur.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  terms_version text not null default '' check (char_length(terms_version) <= 20),
  terms_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists terms_version text not null default '',
  add column if not exists terms_accepted_at timestamptz;

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
-- Les champs attestant l’acceptation ne sont modifiables que par le trigger.
grant update (display_name, updated_at) on table public.profiles to authenticated;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own profile" on public.profiles;
create policy "Users can create their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name, terms_version, terms_accepted_at)
  values (
    new.id,
    left(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 80),
    left(trim(coalesce(new.raw_user_meta_data ->> 'terms_version', '')), 20),
    case when coalesce(new.raw_user_meta_data ->> 'terms_version', '') <> '' then now() else null end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_profile_for_auth_user();

insert into public.profiles (user_id, display_name)
select id, left(trim(coalesce(raw_user_meta_data ->> 'display_name', '')), 80)
from auth.users
on conflict (user_id) do nothing;

create table if not exists public.liturgical_works (
  id text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  title text not null,
  work jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.liturgical_works
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.liturgical_works enable row level security;
revoke all on table public.liturgical_works from anon, authenticated;
grant select, insert, update, delete on table public.liturgical_works to authenticated;

drop policy if exists "Authenticated readers can manage group works" on public.liturgical_works;
drop policy if exists "Authenticated users can read group works" on public.liturgical_works;
create policy "Authenticated users can read group works"
  on public.liturgical_works for select to authenticated
  using (true);

drop policy if exists "Users can insert their own works" on public.liturgical_works;
create policy "Users can insert their own works"
  on public.liturgical_works for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can update their own works" on public.liturgical_works;
create policy "Users can update their own works"
  on public.liturgical_works for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can delete their own works" on public.liturgical_works;
create policy "Users can delete their own works"
  on public.liturgical_works for delete to authenticated
  using ((select auth.uid()) = owner_id);

create index if not exists liturgical_works_owner_updated_idx
  on public.liturgical_works (owner_id, updated_at desc);
