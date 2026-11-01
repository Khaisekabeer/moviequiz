-- Points per round for each player, by round name, for the final scoreboard and results file.
alter table public.participants add column round_scores jsonb not null default '{}'::jsonb;
