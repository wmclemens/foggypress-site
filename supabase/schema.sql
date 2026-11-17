-- Foggy Press reader accounts: every table, rule, limit and function.
-- Paste this whole file into the Supabase SQL editor and press Run. It is safe to run again after changes.
--
-- Books are referred to by their site id (catalog/books.json "id", e.g. 'a-christmas-carol').
-- Row-level security is on for every table: a reader can only see and change rows whose user_id is their own.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  history_on boolean not null default true
);

create table if not exists public.favorites (
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id  text not null check (char_length(book_id) between 1 and 120),
  saved_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create table if not exists public.labels (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name    text not null check (char_length(btrim(name)) between 1 and 200),
  unique (user_id, name)
);

create table if not exists public.label_books (
  label_id uuid not null references public.labels (id) on delete cascade,
  book_id  text not null check (char_length(book_id) between 1 and 120),
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  primary key (label_id, book_id)
);

create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 200),
  note       text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.list_items (
  list_id  uuid not null references public.lists (id) on delete cascade,
  book_id  text not null check (char_length(book_id) between 1 and 120),
  position double precision not null default extract(epoch from now()),
  note     text not null default '' check (char_length(note) <= 200),
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  primary key (list_id, book_id)
);

create table if not exists public.history (
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id         text not null check (char_length(book_id) between 1 and 120),
  last_opened     timestamptz not null default now(),
  chapter         text not null default '' check (char_length(chapter) <= 120),
  progress        real not null default 0 check (progress between 0 and 100),
  opens           integer not null default 1,
  downloaded_pdf  boolean not null default false,
  downloaded_epub boolean not null default false,
  primary key (user_id, book_id)
);

create index if not exists history_recent on public.history (user_id, last_opened desc);
create index if not exists favorites_book on public.favorites (book_id);

-- ---------- row-level security: each reader sees and changes only their own rows ----------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'favorites', 'labels', 'label_books', 'lists', 'list_items', 'history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- a tag or list a reader puts a book on must be their own
create or replace function public.fp_own_label() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from labels where id = new.label_id and user_id = new.user_id) then raise exception 'not your tag'; end if;
  return new;
end $$;
create or replace function public.fp_own_list() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from lists where id = new.list_id and user_id = new.user_id) then raise exception 'not your list'; end if;
  return new;
end $$;
drop trigger if exists fp_owner on public.label_books;
create trigger fp_owner before insert or update on public.label_books for each row execute function public.fp_own_label();
drop trigger if exists fp_owner on public.list_items;
create trigger fp_owner before insert or update on public.list_items for each row execute function public.fp_own_list();
drop function if exists public.fp_check_owner();

-- ---------- limits per reader ----------
create or replace function public.fp_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare n integer; cap integer := tg_argv[0]::integer;
begin
  if tg_table_name = 'list_items' then
    select count(*) into n from list_items where list_id = new.list_id;
  else
    execute format('select count(*) from public.%I where user_id = $1', tg_table_name) into n using new.user_id;
  end if;
  if n >= cap then
    raise exception 'limit reached: % of %', cap, tg_table_name using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists fp_limit on public.favorites;
create trigger fp_limit before insert on public.favorites for each row execute function public.fp_limit('2000');
drop trigger if exists fp_limit on public.labels;
create trigger fp_limit before insert on public.labels for each row execute function public.fp_limit('200');
drop trigger if exists fp_limit on public.lists;
create trigger fp_limit before insert on public.lists for each row execute function public.fp_limit('200');
drop trigger if exists fp_limit on public.list_items;
create trigger fp_limit before insert on public.list_items for each row execute function public.fp_limit('500');
drop trigger if exists fp_limit on public.label_books;
create trigger fp_limit before insert on public.label_books for each row execute function public.fp_limit('20000');

-- history keeps the newest 1,000 books; older ones drop off
create or replace function public.fp_trim_history() returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from history where user_id = new.user_id and book_id in (
    select book_id from history where user_id = new.user_id order by last_opened desc offset 1000);
  return null;
end $$;
drop trigger if exists fp_trim on public.history;
create trigger fp_trim after insert on public.history for each row execute function public.fp_trim_history();

-- a list's "updated" time follows changes to its books
create or replace function public.fp_touch_list() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update lists set updated_at = now() where id = coalesce(new.list_id, old.list_id);
  return null;
end $$;
drop trigger if exists fp_touch on public.list_items;
create trigger fp_touch after insert or update or delete on public.list_items for each row execute function public.fp_touch_list();

-- every new account gets a profile row
create or replace function public.fp_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists fp_new_user on auth.users;
create trigger fp_new_user after insert on auth.users for each row execute function public.fp_new_user();
insert into public.profiles (user_id) select id from auth.users on conflict do nothing;

-- ---------- functions the site calls ----------
-- record a visit to a book's read page (or a download); does nothing while the reader has history off
create or replace function public.record_reading(p_book text, p_chapter text default '', p_progress real default 0,
                                                 p_pdf boolean default false, p_epub boolean default false, p_open boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not coalesce((select history_on from profiles where user_id = auth.uid()), true) then return; end if;
  insert into history (user_id, book_id, chapter, progress, downloaded_pdf, downloaded_epub)
  values (auth.uid(), left(p_book, 120), left(coalesce(p_chapter, ''), 120), greatest(0, least(100, coalesce(p_progress, 0))), p_pdf, p_epub)
  on conflict (user_id, book_id) do update set
    last_opened = now(),
    chapter = case when p_pdf or p_epub then history.chapter else excluded.chapter end,
    progress = case when p_pdf or p_epub then history.progress else excluded.progress end,
    opens = history.opens + case when p_open then 1 else 0 end,
    downloaded_pdf = history.downloaded_pdf or p_pdf,
    downloaded_epub = history.downloaded_epub or p_epub;
end $$;
revoke all on function public.record_reading from public, anon;
grant execute on function public.record_reading to authenticated;

-- "Delete my account": removes the sign-in record; every table above deletes the reader's rows with it
create or replace function public.delete_me() returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_me from public, anon;
grant execute on function public.delete_me to authenticated;

-- ---------- Ask Foggy Press (supabase/functions/ask): past chats, daily limit, monthly spending cap ----------
-- Readers can read and delete their own chats; only the ask function (service role) writes them.
create table if not exists public.chats (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default '' check (char_length(title) <= 200),
  book_id    text not null default '' check (char_length(book_id) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  chat_id    uuid not null references public.chats (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null check (char_length(content) <= 20000),
  blocks     jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists chats_recent on public.chats (user_id, updated_at desc);
create index if not exists chat_messages_chat on public.chat_messages (chat_id, id);

-- one row per question asked: for the daily limit and the monthly cap. Holds no words, only counts;
-- when an account is deleted its rows lose the user id but stay, so the month's spending stays right.
create table if not exists public.ask_usage (
  id            bigint generated always as identity primary key,
  user_id       uuid references auth.users (id) on delete set null,
  asked_at      timestamptz not null default now(),
  local_day     date not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(10, 6) not null default 0
);
create index if not exists ask_usage_user_day on public.ask_usage (user_id, local_day);
create index if not exists ask_usage_time on public.ask_usage (asked_at);

-- the settings, one row: change them in Supabase's Table Editor (table ask_config)
create table if not exists public.ask_config (
  id              boolean primary key default true check (id),
  enabled         boolean not null default true,
  daily_limit     integer not null default 20 check (daily_limit >= 0),
  monthly_cap_usd numeric(10, 2) not null default 10 check (monthly_cap_usd >= 0)
);
insert into public.ask_config (id) values (true) on conflict do nothing;

do $$
declare t text;
begin
  foreach t in array array['chats', 'chat_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, delete on public.%I to authenticated', t);
  end loop;
  foreach t in array array['ask_usage', 'ask_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- the reader's day, in their own time zone (a bad zone name counts as UTC)
create or replace function public.fp_local_day(p_tz text) returns date language plpgsql stable as $$
begin
  return (now() at time zone coalesce(nullif(p_tz, ''), 'UTC'))::date;
exception when others then
  return (now() at time zone 'UTC')::date;
end $$;

-- questions left today, and whether Ask is open (the page shows "17 of 20 questions left today")
create or replace function public.ask_status(p_tz text default 'UTC') returns json language sql security definer set search_path = public stable as $$
  select json_build_object(
    'limit', c.daily_limit,
    'left', greatest(0, c.daily_limit - (select count(*) from ask_usage where user_id = auth.uid() and local_day = fp_local_day(p_tz))),
    'open', c.enabled and (select coalesce(sum(cost_usd), 0) from ask_usage where asked_at >= date_trunc('month', now())) < c.monthly_cap_usd)
  from ask_config c;
$$;
revoke all on function public.ask_status from public, anon;
grant execute on function public.ask_status to authenticated;

-- called by the ask function before it asks the model: counts the question, or says why it can't
create or replace function public.ask_begin(p_user uuid, p_tz text) returns json language plpgsql security definer set search_path = public as $$
declare c ask_config; used integer; spent numeric; d date := fp_local_day(p_tz); new_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('fp-ask:' || p_user::text));
  select * into c from ask_config;
  select coalesce(sum(cost_usd), 0) into spent from ask_usage where asked_at >= date_trunc('month', now());
  if not c.enabled or spent >= c.monthly_cap_usd then
    return json_build_object('ok', false, 'why', 'paused', 'limit', c.daily_limit, 'left', 0);
  end if;
  select count(*) into used from ask_usage where user_id = p_user and local_day = d;
  if used >= c.daily_limit then
    return json_build_object('ok', false, 'why', 'limit', 'limit', c.daily_limit, 'left', 0);
  end if;
  insert into ask_usage (user_id, local_day) values (p_user, d) returning id into new_id;
  return json_build_object('ok', true, 'usage_id', new_id, 'limit', c.daily_limit, 'left', c.daily_limit - used - 1);
end $$;
-- and after: what the answer cost
create or replace function public.ask_finish(p_id bigint, p_in integer, p_out integer, p_cost numeric) returns void language sql security definer set search_path = public as $$
  update ask_usage set input_tokens = p_in, output_tokens = p_out, cost_usd = p_cost where id = p_id;
$$;
revoke all on function public.ask_begin from public, anon, authenticated;
revoke all on function public.ask_finish from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.ask_begin to service_role;
    grant execute on function public.ask_finish to service_role;
    grant select, insert, update, delete on public.chats, public.chat_messages, public.ask_usage to service_role;
    grant select on public.ask_config to service_role;
  end if;
end $$;

-- ---------- Ask without an account, thumbs up or down, the admin Chat tab (17 Nov 2026) ----------
-- Guests: a chat with no user_id, found again only with the key the page holds (its SHA-256 is guest_key).
-- Their questions count against a daily limit per internet address, kept only as a scrambled id ("visitor").
-- Guest chats are deleted after 30 days. Readers' chats stay in their account until they delete them.
alter table public.chats alter column user_id drop not null;
alter table public.chats add column if not exists guest_key text check (guest_key is null or guest_key ~ '^[0-9a-f]{64}$');
alter table public.chat_messages alter column user_id drop not null;
-- a reader's (or guest's) verdict on an answer: 1 thumbs up, -1 thumbs down, with an optional note on what was wrong
alter table public.chat_messages add column if not exists rating smallint check (rating in (-1, 1));
alter table public.chat_messages add column if not exists rating_note text not null default '' check (char_length(rating_note) <= 500);
alter table public.chat_messages add column if not exists rated_at timestamptz;
alter table public.ask_usage add column if not exists visitor text check (visitor is null or char_length(visitor) <= 64);
alter table public.ask_usage add column if not exists place text not null default '' check (char_length(place) <= 16);
alter table public.ask_config add column if not exists guest_daily_limit integer not null default 10 check (guest_daily_limit >= 0);
alter table public.ask_config add column if not exists guests_daily_cap integer not null default 500 check (guests_daily_cap >= 0);
create index if not exists chats_guest_age on public.chats (updated_at) where user_id is null;
create index if not exists ask_usage_visitor_day on public.ask_usage (visitor, local_day) where visitor is not null;
create index if not exists chat_messages_rated on public.chat_messages (rated_at desc) where rating is not null;

-- a guest's questions left today (the Ask box shows "7 of 10 questions left today"), for the ask function only
create or replace function public.ask_guest_status(p_visitor text, p_tz text default 'UTC') returns json language sql security definer set search_path = public stable as $$
  select json_build_object(
    'limit', c.guest_daily_limit,
    'left', greatest(0, c.guest_daily_limit - (select count(*) from ask_usage where visitor = p_visitor and local_day = fp_local_day(p_tz))),
    'open', c.enabled and (select coalesce(sum(cost_usd), 0) from ask_usage where asked_at >= date_trunc('month', now())) < c.monthly_cap_usd,
    'guests', c.guest_daily_limit > 0
      and (select count(*) from ask_usage where visitor is not null and asked_at > now() - interval '1 day') < c.guests_daily_cap)
  from ask_config c;
$$;

-- like ask_begin, for a guest: counts the question against their address's daily limit and all guests' daily ceiling
create or replace function public.ask_begin_guest(p_visitor text, p_tz text, p_place text default '') returns json language plpgsql security definer set search_path = public as $$
declare c ask_config; used integer; spent numeric; d date := fp_local_day(p_tz); new_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('fp-ask-guest:' || p_visitor));
  select * into c from ask_config;
  select coalesce(sum(cost_usd), 0) into spent from ask_usage where asked_at >= date_trunc('month', now());
  if not c.enabled or spent >= c.monthly_cap_usd then
    return json_build_object('ok', false, 'why', 'paused', 'limit', c.guest_daily_limit, 'left', 0);
  end if;
  if c.guest_daily_limit <= 0 or (select count(*) from ask_usage where visitor is not null and asked_at > now() - interval '1 day') >= c.guests_daily_cap then
    return json_build_object('ok', false, 'why', 'guests', 'limit', c.guest_daily_limit, 'left', 0);
  end if;
  select count(*) into used from ask_usage where visitor = p_visitor and local_day = d;
  if used >= c.guest_daily_limit then
    return json_build_object('ok', false, 'why', 'limit', 'limit', c.guest_daily_limit, 'left', 0);
  end if;
  -- guest chats older than 30 days go
  delete from chats where user_id is null and updated_at < now() - interval '30 days';
  insert into ask_usage (visitor, local_day, place) values (p_visitor, d, left(coalesce(p_place, ''), 16)) returning id into new_id;
  return json_build_object('ok', true, 'usage_id', new_id, 'limit', c.guest_daily_limit, 'left', c.guest_daily_limit - used - 1);
end $$;

-- the admin Chat tab (admin/admin.js, through the ask function, only for the site owner's GitHub token):
-- questions and spending by day, where people ask, the books asked about, and the answers people rated.
-- Rated answers show the question and the answer, never who asked.
create or replace function public.ask_admin_report() returns json language sql security definer set search_path = public stable as $$
  select json_build_object(
    'built', now(),
    'config', (select row_to_json(c) from ask_config c),
    'month_cost', (select coalesce(sum(cost_usd), 0) from ask_usage where asked_at >= date_trunc('month', now())),
    'totals_30d', (select json_build_object(
        'questions', count(*),
        'members', count(*) filter (where visitor is null),
        'guests', count(*) filter (where visitor is not null),
        'askers', count(distinct user_id),
        'guest_askers', count(distinct visitor),
        'cost', coalesce(sum(cost_usd), 0),
        'tokens_in', coalesce(sum(input_tokens), 0),
        'tokens_out', coalesce(sum(output_tokens), 0))
      from ask_usage where asked_at > now() - interval '30 days'),
    'days', coalesce((select json_agg(x order by x.day) from (
        select g.day::date as day,
          (select count(*) from ask_usage u where u.asked_at >= g.day and u.asked_at < g.day + interval '1 day' and u.visitor is null) as members,
          (select count(*) from ask_usage u where u.asked_at >= g.day and u.asked_at < g.day + interval '1 day' and u.visitor is not null) as guests,
          (select coalesce(sum(cost_usd), 0) from ask_usage u where u.asked_at >= g.day and u.asked_at < g.day + interval '1 day') as cost,
          (select count(*) from chat_messages m where m.rated_at >= g.day and m.rated_at < g.day + interval '1 day' and m.rating = 1) as up,
          (select count(*) from chat_messages m where m.rated_at >= g.day and m.rated_at < g.day + interval '1 day' and m.rating = -1) as down
        from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') g(day)) x), '[]'::json),
    'places', coalesce((select json_object_agg(p, n) from (select coalesce(nullif(place, ''), 'ask') p, count(*) n from ask_usage where asked_at > now() - interval '30 days' group by 1) s), '{}'::json),
    'ratings', (select json_build_object('up', count(*) filter (where rating = 1), 'down', count(*) filter (where rating = -1),
        'up_30d', count(*) filter (where rating = 1 and rated_at > now() - interval '30 days'),
        'down_30d', count(*) filter (where rating = -1 and rated_at > now() - interval '30 days'),
        'answers_30d', (select count(*) from chat_messages where role = 'assistant' and created_at > now() - interval '30 days'))
      from chat_messages where rating is not null),
    'books', coalesce((select json_agg(json_build_array(book_id, n) order by n desc) from (
        select book_id, count(*) n from chats where book_id <> '' and created_at > now() - interval '30 days' group by book_id order by n desc limit 15) s), '[]'::json),
    'rated', coalesce((select json_agg(r order by r.rated_at desc) from (
        select m.id, m.rating, m.rating_note as note, m.rated_at, c.book_id, (c.user_id is null) as guest,
          left(m.content, 4000) as answer,
          (select left(q.content, 1000) from chat_messages q where q.chat_id = m.chat_id and q.id < m.id and q.role = 'user' order by q.id desc limit 1) as question
        from chat_messages m join chats c on c.id = m.chat_id
        where m.rating is not null order by m.rated_at desc limit 200) r), '[]'::json)
  );
$$;

revoke all on function public.ask_guest_status from public, anon, authenticated;
revoke all on function public.ask_begin_guest from public, anon, authenticated;
revoke all on function public.ask_admin_report from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.ask_guest_status to service_role;
    grant execute on function public.ask_begin_guest to service_role;
    grant execute on function public.ask_admin_report to service_role;
  end if;
end $$;

-- ---------- Build me a book: readers ask for a public-domain book we don't have yet ----------
-- A nightly job (foggy-press-files, .github/workflows/requests.yml) copies new requests into the books repository,
-- where they are built from approved sources, and writes back what happened; the reader is emailed then.
create table if not exists public.book_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 1 and 300),
  author      text not null default '' check (char_length(author) <= 200),
  source_url  text not null default '' check (char_length(source_url) <= 500),
  note        text not null default '' check (char_length(note) <= 500),
  status      text not null default 'new' check (status in ('new', 'building', 'published', 'declined', 'not_found')),
  book_id     text not null default '' check (char_length(book_id) <= 120),
  reason      text not null default '' check (char_length(reason) <= 500),
  notified_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists book_requests_user on public.book_requests (user_id, created_at desc);
create index if not exists book_requests_status on public.book_requests (status);
alter table public.book_requests enable row level security;
drop policy if exists own_rows on public.book_requests;
create policy own_rows on public.book_requests for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.book_requests from anon, authenticated;
grant select on public.book_requests to authenticated;
-- a reader may withdraw a request that hasn't been started
drop policy if exists withdraw_new on public.book_requests;
grant delete on public.book_requests to authenticated;
create policy withdraw_new on public.book_requests as restrictive for delete to authenticated using (status = 'new');

-- the sources a link may point to (the same ones the books are built from)
create or replace function public.fp_approved_source(p_url text) returns boolean language sql immutable as $$
  select coalesce(p_url, '') = '' or p_url ~* '^https?://([a-z0-9-]+\.)*(gutenberg\.org|gutenberg\.ca|hathitrust\.org|archive\.org|wikisource\.org|standardebooks\.org|fadedpage\.com|books\.google\.com)(/|$)';
$$;

-- ask for a book: at most 3 a day and 10 waiting at once per reader, and not the same title twice while waiting
create or replace function public.request_book(p_title text, p_author text default '', p_url text default '', p_note text default '')
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); t text := btrim(coalesce(p_title, '')); new_id uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if char_length(t) < 2 then return json_build_object('ok', false, 'why', 'title'); end if;
  if not fp_approved_source(btrim(coalesce(p_url, ''))) then return json_build_object('ok', false, 'why', 'source'); end if;
  perform pg_advisory_xact_lock(hashtext('fp-req:' || me::text));
  if exists (select 1 from book_requests where user_id = me and status in ('new', 'building') and lower(title) = lower(t)) then
    return json_build_object('ok', false, 'why', 'duplicate');
  end if;
  if (select count(*) from book_requests where user_id = me and created_at > now() - interval '1 day') >= 3 then
    return json_build_object('ok', false, 'why', 'day');
  end if;
  if (select count(*) from book_requests where user_id = me and status in ('new', 'building')) >= 10 then
    return json_build_object('ok', false, 'why', 'open');
  end if;
  insert into book_requests (user_id, title, author, source_url, note)
  values (me, left(t, 300), left(btrim(coalesce(p_author, '')), 200), left(btrim(coalesce(p_url, '')), 500), left(btrim(coalesce(p_note, '')), 500))
  returning id into new_id;
  return json_build_object('ok', true, 'id', new_id);
end $$;
revoke all on function public.request_book from public, anon;
grant execute on function public.request_book to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, update on public.book_requests to service_role;
  end if;
end $$;

-- totals for the admin Reports tab (read at build time): counts only, never a row about a person
create or replace function public.site_totals() returns json language sql security definer set search_path = public, auth stable as $$
  select json_build_object(
    'accounts', (select count(*) from auth.users),
    'new_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'active_30d', (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'
                     or id in (select user_id from history where last_opened > now() - interval '30 days')),
    'favorites', (select count(*) from favorites),
    'lists', (select count(*) from lists),
    'list_items', (select count(*) from list_items),
    'ask_30d', (select count(*) from ask_usage where asked_at > now() - interval '30 days'),
    'ask_askers_30d', (select count(distinct coalesce(user_id::text, visitor)) from ask_usage where asked_at > now() - interval '30 days'),
    'ask_cost_month', (select coalesce(sum(cost_usd), 0) from ask_usage where asked_at >= date_trunc('month', now())),
    'ask_cap', (select monthly_cap_usd from ask_config),
    'chats', (select count(*) from chats),
    'requests_waiting', (select count(*) from book_requests where status in ('new', 'building')),
    'requests_published', (select count(*) from book_requests where status = 'published'),
    'requests_declined', (select count(*) from book_requests where status in ('declined', 'not_found')),
    'saved', coalesce((select json_object_agg(book_id, n) from (select book_id, count(*) n from favorites group by book_id) s), '{}'::json)
  );
$$;
revoke all on function public.site_totals from public;
grant execute on function public.site_totals to anon, authenticated;
