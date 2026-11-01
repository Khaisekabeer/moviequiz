-- PINs belong to question sets now, not to staff accounts, so a quiz master account has no PIN of
-- its own. This rule from the first schema made such accounts impossible to create.
alter table public.staff drop constraint if exists quizmaster_has_pin;
