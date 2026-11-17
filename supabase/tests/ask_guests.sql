-- Ask without an account (17 Nov 2026): the guest daily limit, the all-guests ceiling, guest chats out of readers'
-- sight, thumbs up or down, and the admin report. Run after ask.sql. Expected errors: the two "permission denied" lines.
\set ON_ERROR_STOP 0
update ask_config set daily_limit = 3, guest_daily_limit = 2, guests_daily_cap = 3, monthly_cap_usd = 100;
set role service_role;
select ask_guest_status('visitor-a', 'UTC') as a_status_before;
select ask_begin_guest('visitor-a', 'UTC', 'home')->>'left' as a_first_left_1;
select ask_begin_guest('visitor-a', 'Europe/Paris', 'ask')->>'left' as a_second_left_0;
select ask_begin_guest('visitor-a', 'UTC', 'home')->>'why' as a_third_is_limit;
select ask_begin_guest('visitor-b', 'UTC', 'book')->>'ok' as b_first_ok;
select ask_begin_guest('visitor-c', 'UTC', 'home')->>'why' as c_is_guests_ceiling;
select ask_guest_status('visitor-c', 'UTC')->>'guests' as guests_now_false;
insert into chats (id, title, guest_key) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Guest chat', repeat('a', 64));
insert into chat_messages (chat_id, role, content) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'user', 'Which book is about whales?'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'assistant', 'Moby-Dick.');
update chat_messages set rating = -1, rating_note = 'too short', rated_at = now() where role = 'assistant' and chat_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- an old guest chat is cleared on the next guest question
insert into chats (title, guest_key, updated_at) values ('Old', repeat('b', 64), now() - interval '31 days');
reset role; update ask_config set guests_daily_cap = 100; set role service_role;
select ask_begin_guest('visitor-d', 'UTC', 'home')->>'ok' as d_ok;
select count(*) as old_guest_chats_left from chats where title = 'Old';
select r->'totals_30d'->>'guests' as guest_questions, r->'ratings'->>'down' as thumbs_down, r->'rated'->0->>'question' as rated_question,
  r->'rated'->0->>'guest' as rated_by_guest, r->'places'->>'home' as asked_on_home, json_array_length(r->'days') as days
from (select ask_admin_report() r) x;
reset role;
set role authenticated; select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false);
select count(*) as reader_sees_guest_chats from chats;
select ask_admin_report();
select ask_begin_guest('x', 'UTC', '');
reset role;
