-- Staff accounts are shared with the tech quiz, so each one says which quiz it is for. The default
-- keeps every existing account, and any account the tech quiz adds, on the tech quiz.
alter table public.staff
  add column quiz text not null default 'tech' check (quiz in ('movie', 'tech', 'both'));

-- Active admins work on both, so someone can sign in here and add the movie team.
update public.staff set quiz = 'both' where role = 'admin' and active;
