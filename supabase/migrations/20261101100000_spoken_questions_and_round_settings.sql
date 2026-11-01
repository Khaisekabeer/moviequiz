-- Round settings, all per level. The defaults keep a level playing as it did before.
alter table public.levels
  -- Turns round: after a pass or wrong answer the question goes to the next player, or closes.
  add column after_miss text not null default 'next' check (after_miss in ('next', 'close')),
  -- Buzzer round: no question timer; the coordinator closes the question.
  add column untimed boolean not null default false,
  -- Buzzer round: seconds on the clock after a buzz.
  add column answer_seconds integer not null default 10 check (answer_seconds between 1 and 120),
  -- Everyone still in starts this level at 0, so a final can be scored on its own.
  add column reset_scores boolean not null default false,
  -- Results kept by hand: the round runs (buzzers, turns, passes) but records no points.
  add column manual_results boolean not null default false,
  -- Fixed points for a turn. Null: use each question's own points.
  add column points_correct integer,
  add column points_wrong integer,
  add column points_timeout integer;

-- Spoken questions use the existing 'short' question type: no options, the coordinator marks the
-- answer. Their accepted alternatives are inside the encrypted question content.
