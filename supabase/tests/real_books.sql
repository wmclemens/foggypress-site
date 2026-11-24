-- My Real Books: readers see and change only their own books and fields; scan limits per day, per minute, the
-- monthly cap, and the unlimited account. Run after fake_supabase.sql and schema.sql. Expected errors: the
-- "permission denied", "new row violates" and "violates check constraint" lines.
\set ON_ERROR_STOP 0
reset role; set search_path = public;
insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777','g@x'), ('88888888-8888-8888-8888-888888888888','Owner@X');
set role authenticated; select set_config('request.jwt.claim.sub','77777777-7777-7777-7777-777777777777',false);
insert into real_books (title, author_last, author_first, year, year_read, tags, custom, source)
  values ('Night Rider', 'Warren', 'Robert Penn', 1939, 'read', '{Fiction}', '{"Purchase price": "$12"}', 'photo') returning title, needs_review;
insert into real_books (title, year_read) values ('Bad year read', '1850');                 -- refused: check
insert into real_books (title, user_id) values ('Someone else''s', '88888888-8888-8888-8888-888888888888');  -- refused: policy
insert into real_book_fields (name, position) values ('Purchase price', 0), ('Signed', 1);
update real_books set notes = 'Inscribed: B. B. Torrey' where title = 'Night Rider' returning notes, updated_at > created_at as touched;
select set_config('request.jwt.claim.sub','88888888-8888-8888-8888-888888888888',false);
select count(*) as other_reader_sees from real_books;
update real_books set title = 'hacked'; delete from real_books; select count(*) as other_fields from real_book_fields;
reset role;
select title, year_read, custom->>'Purchase price' as price from real_books;
-- anon sees nothing
set role anon; select count(*) from real_books; reset role;
-- the scan limits: 2 a day, 1 a minute for the test
update scan_config set daily_limit = 2, minute_limit = 1;
set role service_role;
select scan_begin('77777777-7777-7777-7777-777777777777', 'America/Los_Angeles', 2)::jsonb - 'usage_id' as first;
select scan_begin('77777777-7777-7777-7777-777777777777', 'America/Los_Angeles', 1)->>'why' as second_same_minute;
reset role;
update scan_usage set scanned_at = now() - interval '2 minutes';
set role service_role;
select scan_begin('77777777-7777-7777-7777-777777777777', 'America/Los_Angeles', 1)->>'left' as second_after_a_minute;
reset role; update scan_usage set scanned_at = now() - interval '2 minutes'; set role service_role;
select scan_begin('77777777-7777-7777-7777-777777777777', 'America/Los_Angeles', 1)->>'why' as third_over_day;
reset role;
-- the owner's address (any case) has no limits
update scan_config set unlimited_emails = '{owner@x}';
set role service_role;
select scan_begin('88888888-8888-8888-8888-888888888888', 'UTC')->>'unlimited' as owner_1,
       scan_begin('88888888-8888-8888-8888-888888888888', 'UTC')->>'ok' as owner_2,
       scan_begin('88888888-8888-8888-8888-888888888888', 'UTC')->>'ok' as owner_3;
-- the monthly cap stops everyone else, not the owner; the owner's scans don't count toward it
select scan_finish(id, 1000, 200, 30) from scan_usage where user_id = '88888888-8888-8888-8888-888888888888';
reset role; update scan_config set daily_limit = 300, minute_limit = 20; delete from scan_usage where user_id = '77777777-7777-7777-7777-777777777777';
set role service_role;
select scan_begin('77777777-7777-7777-7777-777777777777', 'UTC')->>'ok' as reader_under_cap;
select scan_finish(max(id), 1000, 200, 26) from scan_usage where user_id = '77777777-7777-7777-7777-777777777777';
reset role; update scan_usage set scanned_at = now() - interval '2 minutes'; set role service_role;
select scan_begin('77777777-7777-7777-7777-777777777777', 'UTC')->>'why' as reader_over_cap,
       scan_begin('88888888-8888-8888-8888-888888888888', 'UTC')->>'ok' as owner_over_cap;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub','88888888-8888-8888-8888-888888888888',false);
select scan_status('UTC') as owner_status;
select set_config('request.jwt.claim.sub','77777777-7777-7777-7777-777777777777',false);
select scan_status('UTC') as reader_status;
select * from scan_usage;               -- refused: readers can't read usage
select scan_begin('77777777-7777-7777-7777-777777777777', 'UTC');  -- refused: only the function counts scans
reset role;
-- deleting the account removes the books and fields, keeps the anonymous counts
delete from auth.users where id = '77777777-7777-7777-7777-777777777777';
select (select count(*) from real_books) as books_left, (select count(*) from real_book_fields) as fields_left,
       (select count(*) from scan_usage where user_id is null) as anonymous_counts;
