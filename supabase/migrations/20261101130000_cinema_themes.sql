-- The cinema themes join the comic ones (see comic.css).
alter table public.levels drop constraint levels_theme_check;
alter table public.levels add constraint levels_theme_check check (
  theme is null or theme in ('marquee', 'curtain', 'noir', 'popcorn', 'blast', 'pop', 'arcade', 'circuit', 'classic')
);
