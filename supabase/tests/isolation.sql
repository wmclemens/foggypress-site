\set ON_ERROR_STOP 0
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111','a@x'), ('22222222-2222-2222-2222-222222222222','b@x');
select count(*) as profiles_made from profiles;
-- reader A
set role authenticated; select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
insert into favorites (book_id) values ('moby-dick'), ('dracula');
insert into labels (name) values ('to print') ;
insert into lists (name) values ('Summer');
insert into list_items (list_id, book_id) select id, 'moby-dick' from lists;
insert into label_books (label_id, book_id) select id, 'dracula' from labels;
select record_reading('moby-dick', 'c3', 42.5, false, false, true);
select record_reading('moby-dick', '', 0, true, false, false);
select book_id, chapter, progress, opens, downloaded_pdf from history;
-- reader B tries A's rows
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
select 'B sees favorites' t, count(*) from favorites union all select 'B sees lists', count(*) from lists union all select 'B sees items', count(*) from list_items union all select 'B sees history', count(*) from history union all select 'B sees labels', count(*) from label_books;
update favorites set book_id='x'; delete from lists; 
insert into favorites (user_id, book_id) values ('11111111-1111-1111-1111-111111111111','evil');
insert into list_items (list_id, book_id) select id, 'evil' from lists;  -- sees none
-- B puts book on A's list by id (known id)
reset role; select id as alist from lists \gset
set role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
insert into list_items (list_id, book_id) values (:'alist', 'evil');
-- B turns history off
update profiles set history_on=false; select record_reading('dracula','',1,false,false,true); select count(*) as b_history from history;
-- anon
reset role; set role anon; select set_config('request.jwt.claim.sub','',false);
select count(*) from favorites;
select site_totals();
select record_reading('x');
reset role;
select 'A still has' t, count(*) from favorites where user_id='11111111-1111-1111-1111-111111111111';
-- limits: lists cap
set role authenticated; select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
insert into lists (name) select 'l'||g from generate_series(1,200) g;  select count(*) from lists;
insert into lists (name) values ('one too many');
insert into lists (name) values (repeat('x',201));
-- delete me
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
select delete_me();
reset role;
select 'left after delete' t, (select count(*) from favorites where user_id='11111111-1111-1111-1111-111111111111')+(select count(*) from lists where user_id='11111111-1111-1111-1111-111111111111')+(select count(*) from list_items where user_id='11111111-1111-1111-1111-111111111111')+(select count(*) from history where user_id='11111111-1111-1111-1111-111111111111')+(select count(*) from labels where user_id='11111111-1111-1111-1111-111111111111')+(select count(*) from profiles where user_id='11111111-1111-1111-1111-111111111111') n;
