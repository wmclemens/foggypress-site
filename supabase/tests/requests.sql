-- Build me a book: limits, approved sources, and that readers only see and withdraw their own new requests.
-- Run after isolation.sql and ask.sql. Expected errors: the "permission denied" lines.
\set ON_ERROR_STOP 0
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555','e@x'), ('66666666-6666-6666-6666-666666666666','f@x');
set role authenticated; select set_config('request.jwt.claim.sub','55555555-5555-5555-5555-555555555555',false);
select request_book('Ivanhoe', 'Walter Scott', 'https://www.gutenberg.org/ebooks/82') as first_ok;
select request_book('ivanhoe') as duplicate;
select request_book('Rob Roy', 'Scott', 'https://evil.example.com/x.pdf') as bad_source;
select request_book('Rob Roy', 'Scott', 'https://archive.org/details/robroy00scot') as second_ok;
select request_book('Waverley', '', 'https://en.wikisource.org/wiki/Waverley') as third_ok;
select request_book('Kenilworth') as fourth_over_day;
select request_book('x') as too_short;
insert into book_requests (user_id, title) values ('55555555-5555-5555-5555-555555555555', 'direct insert');
update book_requests set status = 'published';
select title, status from book_requests order by created_at;
select set_config('request.jwt.claim.sub','66666666-6666-6666-6666-666666666666',false);
select count(*) as f_sees_e from book_requests; delete from book_requests; reset role;
select count(*) as e_still_has from book_requests where user_id = '55555555-5555-5555-5555-555555555555';
-- the nightly job starts one; the reader can't withdraw it then, but can withdraw a new one
set role service_role; update book_requests set status = 'building' where title = 'Ivanhoe'; reset role;
set role authenticated; select set_config('request.jwt.claim.sub','55555555-5555-5555-5555-555555555555',false);
delete from book_requests where title = 'Ivanhoe'; delete from book_requests where title = 'Rob Roy';
select title, status from book_requests order by created_at;
reset role; set role anon; select site_totals()::jsonb - 'saved' as totals; reset role;
