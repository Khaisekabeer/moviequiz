# Movie Quiz · Vyuham '26

The live movie quiz of Vyuham '26. It shares its engine with the TechSprint tech quiz and has its own look, question formats and round types.

A real-time multiplayer quiz for live events: participants are checked in at the entry by scanning their pass, answer on their phones, the coordinator conducts the game from a host console, and a projector shows questions and standings. Built and load-tested for 150+ concurrent players.

## Run it locally (recommended)

Everything runs on one laptop: Supabase in Docker, and the pages, admin API and live game in one server. Cloudflare Tunnel publishes it over HTTPS for phones.

```bash
# Once
cd frontend && npm ci && npm run build
cd ../backend && npm ci

# Every time (Docker Desktop must be running)
npm run db:start                 # local Supabase; first run applies migrations and writes backend/.env
npm start                        # pages + API + game on http://localhost:3001
npm run tunnel                   # in a second terminal: publishes it (see the tunnel section below)
```

`db:start` prints the first `admin` password once. It never changes values already in `.env`. **Back up `QUESTION_VAULT_SECRET`**: without it question sets can't be decrypted. `npm run db:stop` stops the database and keeps the data; `npm run db:reset` **wipes everything** and reapplies the migrations.

In this mode leave **Admin → Overview → Live game server** empty and open every page from the tunnel address, so the projector's QR code points phones to the right place. Clips pass through the server (`backend/mediaProxy.js`) because local Supabase can't be reached from other devices. The Vercel + Supabase cloud setup further down remains available but isn't needed.

## Setting up the document's four rounds

In **Admin → Questions**, create four levels:

| Level | Round type | Questions | Settings |
|---|---|---|---|
| 1 Indian Cinema | Standard | 25 multiple choice, 10 s | Multiplier ×1 |
| 2 World Cinema | Standard | 25 multiple choice, 10 s | Multiplier ×1, after this level: Top 5 go through |
| 3 Beyond the Frame | **Turns** | 15 spoken: pictures, audio or video, and text; 20 s | After a pass or wrong answer: **Question closes**. Tick **Results kept by hand** |
| 4 The Final Cut | **Buzzer** | 20 spoken: 5 pictures, 15 text | Time limit: **No limit**. Seconds to answer: 3. Tick **Results kept by hand** |

In rounds 3 and 4 the system runs the question, the buzzer and the pass; the quiz master checks answers and keeps the scores.

- **Round 3:** each question goes to the next finalist, whose phone shows a Pass button. The coordinator presses Correct, Wrong, Pass or No answer, or **Show answer** to reveal it and move on.
- **Round 4:** phones show a Buzz button. The first buzz locks the others and the projector shows who it was. **Wrong** reopens the buzzers for the rest, one attempt each. **Correct** or **Show answer** reveals the answer.
- The coordinator's console shows the answer first. Nothing is scored, the projector shows no standings in these rounds, and the final screen lists the finalists without ranks while the quiz master announces the winners.

Add spare multiple-choice questions with the *Spare question* tick for a tie at 5th place, and use **Sudden death** from the reveal.

To have the system score these rounds instead, untick *Results kept by hand* and set fixed points such as +10 / −5, with **Everyone starts this level at 0** on round 3. **Show only** is a further option: it shows questions with no buzzer or turns.

## Architecture

```
                        ┌──────────── Vercel ─────────────┐
 Phones, projector,     │  all pages (React build)        │      Supabase Postgres
 host console, admin ──►│  /api  admin API (serverless) ──┼───►  staff, registrations,
        │               └────────────┬────────────────────┘      encrypted questions,
        │                            │ Load set (with its PIN)    games, answers
        │ Socket.IO (wss)            │ (server-to-server,              ▲
        ▼                            ▼  GAME_LINK_SECRET)              │
 https://game.yourdomain.com ── Cloudflare Tunnel ── event-day laptop: npm run game
```

- **Vercel** hosts every page and the admin API (login, roles, participants, check-in, encrypted question bank, results) as serverless functions. Staff can work from anywhere, any time — e.g. the quiz master adds questions from home.
- **Live game** (timer, scoring, state) runs on the **event-day laptop** (`npm run game`, Socket.IO), published over HTTPS by **Cloudflare Tunnel**. The server is authoritative: it enforces the timer, scores answers, and never sends correct answers while a question is live. An admin sets its address in **Admin → Overview → Live game server**; every page connects there.
- **Supabase** stores everything persistent. Game writes happen in batches (game start, end of each question, podium), never on the answer path.
- **All-in-one mode** (`npm start`) still runs API + game + pages in one process — for development, or as a laptop-only fallback.

| Path | Who | Purpose |
|---|---|---|
| `/` | Players | Join with the ticket ID on their pass, answer on the phone |
| `/admin` | Staff | Role-based admin panel (see below) |
| `/host` | Coordinator, admin | Conducts the live event |
| `/screen` | Projector | Join QR code, questions, standings, podium |

## Staff roles

Every staff member has their own login (username or email), created by an admin in **Admin → Staff**. Each account also says which quiz it is for: **Movie quiz**, **Tech quiz** or **Both quizzes**. Tech quiz accounts can't sign in here, and an admin can change this at any time.

| Role | Responsibility | Can do |
|---|---|---|
| **Admin** | Management | Import participants (MakeMyPass CSV), check-in dashboard, scan passes, manage staff, settings (game server address, *require check-in*), results CSV, host console. Can't read question sets (only load one with its PIN) |
| **Quiz master** | Questions & answers | **Question sets** (e.g. Main set, Trial set), each encrypted with its own PIN chosen by the quiz master: levels, questions, pictures, timers, points, themes; gives the coordinator the PIN of the set to play |
| **Coordinator** | Conducts the live event | Host console: **loads a question set with its PIN**, then start, next question, reveal, disqualify, reset; live monitor |
| **Volunteer** | Monitors the live event | Pass check-in scanner and the read-only live monitor (who is online/disconnected, answers in) |

- **First sign-in:** on first start the server creates an admin `admin` whose password is `ADMIN_PASSWORD` from `backend/.env`. If that is not set, a random password is printed once in the server log. Sign in, create real accounts, then change or disable `admin`.

## Question sets & PINs

Questions are only ever visible to quiz masters until they appear live on the projector.

- **Sets:** questions live in **question sets** — e.g. *Main set* (the real event) and *Trial set* (a practice round). Each set has its own levels, questions, **PIN** and **recovery code**. The PIN belongs to the set, not to an account.
- **Quiz master:** creates a set (Admin → Questions → *+ New question set*), names it and chooses its PIN (4–12 digits). Opening a set with its PIN unlocks it for editing for 30 minutes (*Lock · switch set* ends it early). From the open set they can rename it, **change the PIN**, make a **new recovery code**, or delete it.
- **Coordinator:** loads the set to play from the **host console** (lobby → *Question set*): pick the set, enter the PIN the quiz master gave them, *Load set*. They never see the questions — they go straight to the game server's memory and reach phones/projector one at a time (answers only at the reveal). After a game-server restart, load the set again. A quiz master can also load the set they have open, to test it.
- **Encryption:** each question's text, options, answer and picture is encrypted (AES-256-GCM) with the set's key. The key is stored only sealed with a key derived from the **set PIN plus the server secret** `QUESTION_VAULT_SECRET`, so a copy of the database can't be brute-forced, and admins can't read questions. Wrong PINs are limited (5 per person per 5 minutes, 30 per set per 15 minutes).
- **Forgot a set's PIN:** *Forgot PIN* on the set → enter that set's recovery code → choose a new PIN. Without the PIN or the recovery code, the set can't be opened by anyone.
- **Moving the old question bank:** questions written before sets existed are in *Trial set*, which needs a PIN once: a quiz master clicks *Set up*, enters their **old quiz master PIN** (or the old recovery code) and chooses the new set PIN.
- **Back up `QUESTION_VAULT_SECRET`** (backend `.env` and Vercel). Without it, no set can be decrypted, even with the right PIN.
- `npm run seed` / `npm run seed:test` add plaintext questions to a set (default *Trial set*); they're encrypted the next time a quiz master opens it. Keep real questions out of `seed_questions.json` and out of git.

## Check-in flow

1. **Admin** exports the attendee list from MakeMyPass (bookings) as CSV and uploads it in **Admin → Participants** (columns are auto-detected; re-importing updates details and never clears check-ins). Excel files: save as CSV first.
2. **Volunteer** opens **Admin → Check-in** on a phone, starts the camera and scans the QR code on the pass (it contains the ticket ID, e.g. `MMP49081761`). The participant's details appear; tap **Admit**. Unknown and already-admitted tickets are flagged. Manual ticket entry is always available.
3. **Participant** joins the quiz at `/` with the ticket ID from their pass. Only admitted tickets can play; one device per ticket. A player on a new phone can take their seat back if the old one disconnected, by entering the last 4 digits of the phone number they registered with. Repeated wrong ticket IDs or digits are throttled.
4. Fallback: an admin can switch off **Require check-in to play** (Overview) so anyone joins with just a name.

The camera needs HTTPS — Vercel provides it. (In all-in-one LAN mode, `HTTPS=true npm start` serves a self-signed certificate instead.)

## Deployment

### Secrets

| Variable | Where | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Vercel + laptop | Supabase → Project Settings → API Keys |
| `QUESTION_VAULT_SECRET` | Vercel (+ laptop for all-in-one mode) | Decrypts the question bank with the quiz master's PIN. **Back it up.** |
| `GAME_LINK_SECRET` | Vercel + laptop (same value) | Authenticates loading a question set from Vercel to the laptop |
| `ADMIN_PASSWORD` | first run only | Password of the bootstrap `admin` account |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Never commit `.env`.

### 1. Supabase
Run the files in [`supabase/migrations/`](supabase/migrations/) in order (SQL Editor).

**Shared with the tech quiz.** This quiz can use the TechSprint Supabase project, and the live event does. Run the migrations there one at a time, not with `supabase db push`: that project's migration history has different version numbers, so a push would try to run the old files again.

- Participants and check-ins are the quiz's own (`movie_registrations`, `movie_checkin_events`, `participants.movie_ticket_id`), so tech tickets can't join and tech records stay as they are.
- Give this app its own `QUESTION_VAULT_SECRET`. Both apps list every set, but a set only opens under the secret it was created with.
- Staff accounts are in one shared table, and the **Quiz** field on each says who can sign in here. Accounts from before that field are Tech quiz accounts, except active admins, who are on both. `ADMIN_PASSWORD` is only used if this quiz has no staff at all.
- `game_server_url` is shared, so only one quiz can run at a time.
- `SUPABASE_SECRET_KEY` must be the `service_role` or secret key. The `anon` or publishable key can't read or write anything here.

### 2. Vercel (pages + admin API)
1. Import the GitHub repo into Vercel. Keep the **root directory** as the repo root — [`vercel.json`](vercel.json) deploys `frontend/` and `backend/` as two services of one project and routes `/api/*` to [`backend/vercel-entry.js`](backend/vercel-entry.js).
2. Add the environment variables above (Production).
3. Deploy. Staff sign in at `https://<your-app>.vercel.app/admin`.

Functions run in Sydney (`syd1`, next to the Supabase database); change `regions` in `vercel.json` if you move the database.

### 3. Event-day laptop (live game) + Cloudflare Tunnel
One-time:
1. Free Cloudflare account; add your domain to Cloudflare (at GoDaddy, switch the domain's nameservers to the two Cloudflare gives you).
2. Install `cloudflared`: `winget install --id Cloudflare.cloudflared -e`, or put the standalone `cloudflared.exe` in `%LOCALAPPDATA%\cloudflared`. [`backend/tunnel.js`](backend/tunnel.js) looks in both places.
3. On the laptop: `cd backend && npm install`, create `backend/.env` with the Supabase keys and the same `GAME_LINK_SECRET` as Vercel.
4. Create the tunnel. The browser opens once to sign in; this creates a tunnel called `moviequiz`, points the hostname at it and writes `backend/cloudflared.yml`:
   ```bash
   cd backend && npm run tunnel:setup -- game.yourdomain.com
   ```
5. Admin → Overview → **Live game server**: enter `https://game.yourdomain.com` and save.

Event day (two terminals on the laptop):
```bash
cd backend && npm run game                # live game on :3001
cd backend && npm run tunnel              # publishes it at https://game.yourdomain.com
```
Admin → Overview should show the game server **Online**. Players, projector and host console are all opened from the Vercel address.

**Rehearsing without a domain:** `npm run tunnel:quick` needs no Cloudflare account and prints a temporary `https://….trycloudflare.com` address to paste into Admin → Overview. The address changes on every run and quick tunnels have no uptime guarantee and limit in-flight requests, so use the named tunnel for the real event.

### All-in-one mode (development / fallback)
```bash
cd backend && npm run dev                 # API + live game on :3001
cd frontend && npm run dev -- --host      # UI on :5173
```
Leave the game server address empty. Test data: `npm run seed:test` in `backend/` adds 30 dummy tickets (`TEST0001`-`TEST0020` checked in, `TEST0021`-`TEST0030` not) and 10 test questions across the 3 rounds. For a laptop-only event without Vercel: `npm run build` in `frontend/`, then `HTTPS=true npm start` in `backend/` and open `https://<laptop-ip>:3001`. Docker: `docker compose up --build -d`.

### 4. Hosting under a subfolder on Apache (e.g. `vyuham.duk.ac.in/moviequiz/`)

Serve the React build from a subfolder on a shared Apache server, alongside the existing techfest site. Apache only serves static files: the admin API stays on Vercel and the live game stays on the event-day laptop (Cloudflare Tunnel). Keep the Vercel deployment running — the Apache pages depend on it.

```
vyuham.duk.ac.in (Apache shared hosting)
├── index.html              ← existing techfest site
└── moviequiz/               ← contents of frontend/dist (npm run build:apache)
    ├── index.html
    ├── .htaccess            ← generated: SPA rewrite + caching rules
    └── assets/              ← bundled JS, CSS, fonts

<your-app>.vercel.app/api/*            ← admin API, check-in, /api/config (always on)
game.yourdomain.com (Cloudflare Tunnel → laptop :3001)  ← live game (Socket.IO), event day only
```

The game server has no `/api/*` routes, so the Apache build must call the **Vercel** address for the API; it then finds the game server through `/api/config` (Admin → Overview → Live game server), exactly as on Vercel.

The normal `npm run build` (Vercel, local, Docker) is unaffected — the subfolder settings only apply in the separate `apache` build mode, so there is nothing to revert.

#### Step 1: Configure and build

Fill in the Vercel address in [`frontend/.env.apache`](frontend/.env.apache) (change `VITE_BASE_PATH` too if you use a folder other than `/moviequiz/`):

```env
VITE_BASE_PATH=/moviequiz/
VITE_API_BASE=https://<your-app>.vercel.app
```

```bash
cd frontend
npm install
npm run build:apache
```

This creates `frontend/dist/`, including the `.htaccess` file. The build refuses to run if `VITE_API_BASE` is missing.

| URL on Apache | Page |
|---|---|
| `vyuham.duk.ac.in/moviequiz/` | Player join (the projector QR code points here) |
| `vyuham.duk.ac.in/moviequiz/host` | Host console |
| `vyuham.duk.ac.in/moviequiz/screen` | Projector screen |
| `vyuham.duk.ac.in/moviequiz/admin` | Admin panel |

#### Step 2: Upload to the server

Use cPanel File Manager or FTP:

1. Find the document root for `vyuham.duk.ac.in` (usually `public_html/` or a subdomain folder).
2. Create a `moviequiz/` directory inside the document root.
3. Upload the **contents** of `frontend/dist/` into `moviequiz/`, including the hidden `.htaccess` file (enable "Show hidden files" in cPanel). Delete the old files first when re-uploading.

> `.htaccess` needs `mod_rewrite` and `AllowOverride` — most shared hosts allow both. Test by opening `vyuham.duk.ac.in/moviequiz/admin` directly and refreshing it: a 404 means the rewrite isn't active (ask the host to enable it).

The site must be served over **HTTPS** — the check-in camera and the API calls to Vercel need it.

#### Step 3: Event day

Same as [section 3](#3-event-day-laptop-live-game--cloudflare-tunnel): run `npm run game` and `npm run tunnel` on the laptop, and set the game server address in Admin → Overview. Players, projector and host console are opened from the Apache address.

#### Step 4: (Optional) Redirect from `#/techfest`

If the organizer wants the exact URL `vyuham.duk.ac.in/#/techfest` to land on the quiz, add this to the existing techfest site's root `index.html`:

```html
<script>
  if (location.hash.startsWith('#/techfest')) {
    location.replace('/moviequiz/');
  }
</script>
```



## Questions & scoring

**Levels** are set up by the quiz master in Admin → Questions: add as many as needed, name them, and give each a points multiplier (default: 1 Warm-up ×1, 2 Core Tech ×2, 3 Brain Burner ×3). They are played in tab order, each opening with an intro on the projector; empty levels are skipped. A level can be deleted once it has no questions.

**Looks:** the projector and phones use comic-style themes: the cinema set **Marquee** (midnight blue and gold), **Curtain** (velvet red), **Noir** (black and white) and **Popcorn** (cream and red), then **Blast** (yellow sunburst), **Pop** (yellow & pink pop art), **Arcade** (lime burst), **Circuit** (blue tech windows) and **Classic** (plain white). Each level can have its own (level settings → "Look on screen"); left on *Automatic*, every round gets the next theme. The lobby and podium use Marquee, with the Vyuham logo throughout.

**Answer types** are set per question. **Multiple choice** and **True / False** are answered and scored on phones. **Spoken** has no options: the player says the answer, and the coordinator presses Correct, Wrong, Pass or No answer in the host console, which alone shows the answer and accepted alternatives while the question is live. Phones and the projector get the answer only at the reveal. Nothing is scored on a spoken question until the coordinator presses a button, even when the timer runs out. Spoken questions need a buzzer or turns round.

**Round types** are set per level (level settings → "Round type"). **Show only** shows questions and answers and collects and scores nothing. For the others, Turns rounds are called *Passing* in the table below:

| Round | How it plays | Scoring |
|---|---|---|
| **Standard** | Everyone answers on their phone before the timer ends | `points × multiplier`, scaled by speed, plus the first-to-answer and streak bonuses |
| **Buzzer** | The question opens with a big Buzz button on every phone. The first buzz to reach the server gets 10 seconds to answer, and the question's timer stops meanwhile | Correct: full points, and the question ends. Wrong or out of time: minus half the points and locked out of this question; the buzzers reopen with the time that was left |
| **Passing** | Players take turns holding the question, answering or passing. The first player has the full timer; after a pass, each turn is half the timer (at least 5 s). The first go moves to the next player with each question | Correct: full points on the first turn, half after a pass. Wrong, pass or out of time: no penalty, and the question moves on |

The table shows the defaults. Each level can change them: **After a pass or wrong answer** (next player, or the question closes), **Fixed points** for correct / wrong / no answer in place of the amounts above, **Time limit** (none, so the coordinator closes the question) and **Seconds to answer** after a buzz.

In both special rounds there is no speed, first-to-answer or streak bonus; a correct answer still counts towards a player's streak. Players who didn't hold a question are unaffected by it. A question that moves on reaches at most 6 players (offline players are skipped). The host can end or cancel a question as usual. Buzzes are ranked by arrival at the server, so a player on slower internet is at a small disadvantage: put everyone on the same Wi-Fi and test with five people. Buzzers that act as a USB keyboard can be mapped to players in the host console.

**Everyone starts this level at 0** gives a final its own scores: earlier rounds only pick the finalists. Both totals stay in the results CSV, one column per round. The host console's **Show scoreboard** puts a round-by-round table on the projector, and buzzer and turns rounds show live scores for up to 8 players.

**Sudden death:** from a reveal, the host console picks tied players and a spare question. It decides their order and changes no score. With options, the fastest correct answer wins; with a spoken spare, players buzz, the first correct answer wins, and a wrong answer hands the question to the others. If nobody gets it, play another spare. At a pending cut the winner moves above the line.

**Set tools** in Admin → Questions: import questions from a spreadsheet saved as CSV, check a set for uneven A–D answer positions, answers repeated across rounds and consecutive question kinds, and print an answer sheet. Questions in a spreadsheet are added without media; attach pictures and clips in the editor.

**Standings** on the projector show everyone still in, and the layout follows the size of the field: a dense grid for a crowd (80 players → 8 × 10 tiles), rows for 11–30, big character cards for the final 10. Before a cut, players below it are marked at risk; phones show each player's rank ("#12 of 80") and whether they're inside the cut.

**Names:** with check-in on, players appear under their registered name, so the shortlist reads straight off the leaderboard. Two people with the same name are told apart by the end of their ticket ID.

**Avatars:** players pick a character (cartoon person or robot) when they join; it appears on the projector, podium, host console and live monitor. Drawn in the browser (DiceBear Avataaars and Bottts, free for commercial use).

**Question formats** are chosen at the top of the question editor. Every format has the same answer options on phones.

| Format | Shows | Text |
|---|---|---|
| **Text** | The question on the projector | Required |
| **Image only** | A picture on the projector, e.g. "name this film" from a still | None |
| **Image + text** | Picture and question side by side | Required |
| **Audio** | A clip played through the projector, e.g. a dialogue or a song | Optional |
| **Video** | A clip played on the projector | Optional |

Pictures are resized in the browser, stored encrypted with the question key, and served by the live game server only once that question is live, on the projector only.

**Answer notes:** the question editor has an optional note of up to 300 characters. It is stored in the encrypted content, is sent only at the reveal, and appears on phones and the projector under the answer.

**Code in a question:** put a `*` before and after code, on its own line or across several lines, and it shows as a code block with its indentation kept. Inside a sentence, `*x*` shows as inline code. Long questions shrink to fit the projector.

**Cancelling and backups:** the host console can cancel a live question or a playing video. Its answers are dropped: no points, no skip, no answer time. The reveal shows "Cancelled", and a cut or the end of the round still happens. Questions marked as a backup in the editor are left out of the game. After a cancel the host can play one in its place, in the same round.

**Audio and video clips:** add an MP3, M4A, WAV or OGG audio file, or an MP4 or WebM video, up to 50 MB. The file is kept in the private `question-videos` storage bucket, and the question refers to it from its encrypted content. It plays on the projector first and phones say "Listen up!" or "Watch the big screen". The host console can pause, play and replay it, and the question, answers and timer start only when the host presses Start question. The link is sent only while it plays and lasts 12 hours.

Each question belongs to a level and is multiple-choice (2-4 options) or true/false, a timer (5-300 s) and base points. Hidden questions stay in the bank but are left out of the game.

Scoring: `points × level multiplier`, scaled from 100% (instant) to 50% (last second), plus 20% of that base for the first correct answer on a question and 10% on each correct answer in a streak of 3+. Standings: higher score first; on a tie, less total answer time (a skipped question counts as its full timer, so skipping never helps).

**Scoring rules** (host console, lobby): the coordinator can switch off level multipliers, the first-to-answer bonus and the streak bonus, and switch on **Reset points every round**, where everyone still in starts each round at 0 and the cut uses that round's points. Unticking the first three and ticking the reset gives Kahoot-style scoring with eliminations. The rules lock when the game starts and are saved with the game.

## Eliminations & disqualification

- **Cut rules per level** (Admin → Questions → level settings → *After this level*): **Top N go through**, **Top X% go through**, **minimum score**, **bottom N are out**, or **at least K correct answers in this level**. *Tie at the line*: the faster player goes through, or everyone tied goes through. *Everyone goes through* = no cut; the final level never cuts.
- **During the level** the projector marks who is currently below the line, and each phone shows "Above / Below the line".
- **The coordinator confirms every cut.** When the level's last question ends, the host console shows *Going through* and *Out* lists (rank, score, correct answers in the level); **Keep** / **Remove** moves anyone across the line, then **Confirm cut**. Nobody is eliminated before that, and the next round can't start until it's confirmed. The projector shows "The cut is coming…", then "End of <level>! N go through · M eliminated"; eliminated phones show their rank and score and can keep watching.
- **Out (manual):** between questions the coordinator can eliminate any player (e.g. a panel decision) — recorded as eliminated by the host, with a rank. **DQ** disqualifies with a reason (e.g. "Using a second phone"): the live answer is discarded and there's no final rank. In the lobby, **Kick** simply removes a player.
- **Animated standings:** each reveal first shows the previous order and scores, then every row slides to its new rank while the score counts up (▲/▼ shows the change); at a cut the eliminated leave and the rest close up.
- **Where it's stored:** players stay in `participants` with `status` = `active` / `eliminated` / `disqualified` (their answers and log must survive), and every exit gets a row in `eliminations`: round, level, reason (`cut` / `manual` / `disqualified`), note (the rule or the staff reason), rank and score at exit, and the staff member.
- **Final ranking:** finalists by score, then the eliminated (later rounds first, then by score), then the disqualified with no rank. The results CSV includes status, round and reason.

## Activity log & malpractice

Every candidate's actions are logged in `participant_events` (written in batches, a few thousand rows per game): join, failed join attempts (unknown ticket, not checked in, wrong phone digits), seat moved to a new device, reconnects, disconnects, every answer (option, correct, time, points), rejected answers (late, duplicate, after elimination), **leaving the quiz screen during a question** and for how long, elimination and disqualification. Admin → Overview → **Activity log** downloads it as a CSV for any game. IP addresses are logged for joins and reconnects; keep the log only as long as needed.

Precautions against malpractice:

| Risk | Protection |
|---|---|
| Seeing questions early | Encrypted bank, visible only to quiz masters; questions reach phones only when they go live |
| Peeking at a neighbour's result | The correct answer and right/wrong are sent only at the reveal |
| Answering late or twice, changing answers | The server keeps the time (1 s grace for latency) and accepts one answer per question |
| Someone else playing for you | Check-in at the entry by pass; one device per ticket; moving to another device needs the last 4 digits of the registered phone |
| Guessing ticket IDs | Throttled after 8 wrong attempts per connection (60 per IP in 10 minutes) |
| Looking up answers on the same phone | Short timers and speed scoring; leaving the quiz screen is flagged to staff (count and seconds away) |
| Scripted / bot answering | Very fast correct answers (< 1.5 s on 10 s+ questions) are flagged |
| Tampered messages | The server validates every message; options must match the question; eliminated or disqualified players can't answer |

Flags appear in the host console and the volunteers' **Live monitor** ("to watch"), sorted to the top. They are hints, not proof (a notification can hide the page for a moment): an invigilator checks in person and the host decides whether to disqualify. Copying from a neighbour can't be detected by software; seating and invigilators handle that.

## Running the event

1. Laptop: `npm run game` + `npm run tunnel`; Admin → Overview shows the game server **Online**.
2. Volunteers sign in at `/admin` on their phones and check people in at the entry.
3. Projector: open `/screen` on the Vercel address, press F11. Its QR code points players to the Vercel address.
4. Coordinator: host console → *Question set* → pick the set (e.g. Trial set for a practice round, then Main set) → enter its PIN from the quiz master → **Load set**.
5. Coordinator: `/admin` → Live event → **Open host console**.
6. Players scan the QR and join with their ticket ID while the game is in the lobby.
7. **Start game** → **Next question**. Each question ends automatically when its timer runs out. After the last question, **Show final results** shows the podium; every phone shows its rank.
8. Admin: Overview → **Download CSV** for the results (the latest finished game by default; earlier, reset or test games can be picked from the list).

### Day-of checklist
- [ ] Real staff accounts created; `admin` password changed or account disabled
- [ ] Participant CSV imported; a test pass scans and admits correctly
- [ ] Game server **Online** in Admin → Overview; laptop on power and won't sleep
- [ ] Every set has a PIN; the coordinator has the PIN of the set to play and can **Load set**; question count correct in the host console
- [ ] Each set's recovery code, `QUESTION_VAULT_SECRET` and `GAME_LINK_SECRET` stored safely offline
- [ ] Venue internet works for players' phones (backup: mobile data / hotspot)
- [ ] Test with 2-3 phones before the crowd arrives
- [ ] Supabase project is active (free projects pause after a week of inactivity)

## Event simulation

Rehearse the event with bot players that behave like a real crowd: different speeds and accuracy, a few who skip questions, late joiners and phones that drop and reconnect. The quiz master loads the questions first.

```bash
cd backend
npm run simulate                                # 40 bots join; you conduct from /host and watch /screen
node simulate-event.js --players=100            # more bots
SIM_USER=... SIM_PASSWORD=... node simulate-event.js --auto   # the script conducts the whole game
```

- With check-in required, the bots use tickets `SIM0001…`, added as checked in (remove them in the Supabase dashboard afterwards).
- Bots answer the test questions from `npm run seed:test` correctly according to their skill; other questions at random.
- Bots rejoin after a game reset, so you can run several rounds. Event-day server: `--server=https://game.yourdomain.com`.
- `--auto` options: `--lobby=10`, `--intro=4`, `--reveal=6` (seconds). Results are saved to Supabase like a real game.

## Tests

```bash
cd backend
npm test
```

Spec tests for the game rules (scoring, answer timing, cuts, rounds, media links), a full two-level game, question encryption and staff passwords. They need no database or network. Integration tests run the real API and game server on localhost with real Socket.IO clients: access control on every API route, host control, secrecy of questions and answers, seat handling, hostile input, full games and 150 phones answering at once.

## Load test

```bash
cd backend
SERVER_URL=http://localhost:3001 node load-test.js 150
```

Runs against the all-in-one server. Runs the game as an admin/coordinator (`LOADTEST_USER` / `LOADTEST_PASSWORD`); set `LOADTEST_SET` / `LOADTEST_SET_PIN` (a set name and its PIN) to have it load that set, like the coordinator. Seeds checked-in `LTTEST…` tickets when check-in is required, plays a full game with 150 simulated players, checks rejoin and malformed input, and reports latency. It resets the server's current game and saves results to Supabase like a real game.

## Limitations

- The game server holds the live game in memory; if it restarts mid-game the in-progress game is lost (results saved so far remain in Supabase). Staff stay signed in across restarts.
- Every phone needs internet: pages come from Vercel and the game goes through Cloudflare. Quiz traffic is small, but the venue connection must be reliable.
- Vercel functions can't hold WebSockets, which is why the live game runs on the laptop (or any long-running server).
