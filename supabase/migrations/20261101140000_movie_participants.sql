-- The movie quiz can share a database with the tech quiz, so it keeps its own participants: a tech
-- ticket can't join this quiz, and importing or checking in here leaves the tech records alone.
create table public.movie_registrations (
  ticket_id     text primary key check (ticket_id <> '' and ticket_id = upper(ticket_id)),
  name          text not null,
  email         text,
  phone         text,
  college       text,
  extra         jsonb not null default '{}'::jsonb,
  checked_in_at timestamptz,
  checked_in_by uuid references public.staff (id) on delete set null,
  imported_at   timestamptz not null default now()
);
create index movie_registrations_name_idx on public.movie_registrations (lower(name));
create index movie_registrations_checked_in_at_idx on public.movie_registrations (checked_in_at);
create index movie_registrations_checked_in_by_idx on public.movie_registrations (checked_in_by);

-- Audit trail of admissions and undos.
create table public.movie_checkin_events (
  id         bigint generated always as identity primary key,
  ticket_id  text not null references public.movie_registrations (ticket_id) on delete cascade,
  staff_id   uuid references public.staff (id) on delete set null,
  action     text not null check (action in ('admit', 'undo')),
  created_at timestamptz not null default now()
);
create index movie_checkin_events_ticket_idx on public.movie_checkin_events (ticket_id);
create index movie_checkin_events_staff_idx on public.movie_checkin_events (staff_id, created_at desc);

-- participants.ticket_id must match a tech ticket, so movie players link here instead.
alter table public.participants
  add column movie_ticket_id text references public.movie_registrations (ticket_id) on delete set null;
create index participants_movie_ticket_idx on public.participants (movie_ticket_id);
create unique index participants_game_movie_ticket_uq on public.participants (game_id, movie_ticket_id) where movie_ticket_id is not null;

alter table public.movie_registrations  enable row level security;
alter table public.movie_checkin_events enable row level security;
