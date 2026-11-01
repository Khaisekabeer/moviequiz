-- Round types: a level can be a buzzer round, a turns round, or show only: the projector shows the
-- questions and the quiz master runs the answers and scores by hand (see gameEngine.js).
alter table public.levels
  add column mode text not null default 'standard'
  check (mode in ('standard', 'buzzer', 'passing', 'display'));

-- Audio questions: clips use the same private bucket and index as question videos.
update storage.buckets
set allowed_mime_types = array[
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm'
]
where id = 'question-videos';

alter table public.question_videos drop constraint question_videos_mime_check;
alter table public.question_videos add constraint question_videos_mime_check check (mime in (
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm'
));
