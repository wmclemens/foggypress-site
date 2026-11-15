-- Ask Foggy Press: the daily limit, the monthly cap, and that readers can only read and delete their own chats.
-- Run after isolation.sql (see supabase/README.md). Expected errors: the three "permission denied" lines.
\set ON_ERROR_STOP 0
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333','c@x'), ('44444444-4444-4444-4444-444444444444','d@x');
update ask_config set daily_limit = 3, monthly_cap_usd = 1;
set role service_role;
select ask_begin('33333333-3333-3333-3333-333333333333', 'America/New_York');
select ask_begin('33333333-3333-3333-3333-333333333333', 'Not/AZone');
select ask_begin('33333333-3333-3333-3333-333333333333', 'America/New_York');
select ask_begin('33333333-3333-3333-3333-333333333333', 'America/New_York') as fourth_should_be_limit;
insert into chats (id, user_id, title) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'Sea books');
insert into chat_messages (chat_id, user_id, role, content) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'user', 'hi');
select ask_finish(1, 1000, 200, 0.6);
select ask_begin('44444444-4444-4444-4444-444444444444', 'UTC') as d_first;
select ask_finish(5, 1000, 200, 0.5);
select ask_begin('44444444-4444-4444-4444-444444444444', 'UTC') as d_should_be_paused;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
select ask_status('America/New_York');
select count(*) as c_sees_chats from chats; select count(*) as c_sees_msgs from chat_messages;
insert into chats (user_id, title) values ('33333333-3333-3333-3333-333333333333','forged');
select ask_begin('33333333-3333-3333-3333-333333333333', 'UTC') as reader_cannot_call;
select count(*) from ask_usage;
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false);
select count(*) as d_sees_c_chats from chats; delete from chats; 
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
delete from chats where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; select count(*) as after_own_delete from chats;
select delete_me();
reset role;
select count(*) as usage_rows_kept, count(user_id) as with_user from ask_usage;
set role anon; select site_totals(); reset role;
