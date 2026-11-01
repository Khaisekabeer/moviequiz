// Records two scripted games for the demo in frontend/demo: the real game server and engine, real
// Socket.IO clients as the projector, host console, live monitor and phones, and everything each
// one receives, step by step. The demo page replays that into the real pages, so what it shows is
// what the server sends, not a mock-up.
//
// Usage: node demo-record.js      (or `npm run demo` in frontend/, which also builds the page)
//
// Only the database and sign-in storage are replaced, as in test/integration.test.js. This script
// never reads .env, so it can't touch Supabase. Questions, people and tickets here are made up.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

process.env.QUESTION_VAULT_SECRET = crypto.randomBytes(32).toString('base64');

const OUTPUT = path.join(__dirname, '..', 'frontend', 'demo', 'recording.json');

// ─── Stand-ins ────────────────────────────────────────────────────────────────
const sessions = new Map();
const registrations = new Map();
const staffRow = { id: crypto.randomUUID(), username: 'coordinator', display_name: 'Coordinator', role: 'coordinator', active: true };
const known = {
  normalizeTicketId: raw => (typeof raw === 'string' ? raw.trim().toUpperCase() : ''),
  insertSession: async row => { sessions.set(row.token_hash, row); },
  getSessionWithStaff: async hash => (sessions.has(hash) ? { ...sessions.get(hash), staff: staffRow } : null),
  getSettings: async () => ({ require_checkin: true, game_server_url: '' }),
  getRegistration: async id => registrations.get(id) ?? null,
};
const stub = (file, exports) => {
  const filename = path.join(__dirname, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
stub('store.js', new Proxy(known, { get: (t, k) => (k in t ? t[k] : async () => null) }));
stub('db.js', new Proxy({}, { get: () => async () => {} }));

const auth = require('./auth');
const engine = require('./gameEngine');
const createGame = require('./game');

// ─── The field ────────────────────────────────────────────────────────────────
const NAMES = ['Ananya Thomas', 'Rohan Pillai', 'Diya Menon', 'Arjun Varghese', 'Kiran Joseph', 'Meera Kumar', 'Aarav Nair', 'Sneha Das',
  'Rahul Krishnan', 'Fathima Rahman', 'Nikhil George', 'Lakshmi Babu', 'Adil Rahman', 'Gauri Nair', 'Vishnu Menon', 'Nandana Pillai',
  'Sidharth Thomas', 'Aleena Joseph', 'Hari Kumar', 'Riya Varghese', 'Amal Das', 'Devika Krishnan', 'Joel George', 'Parvathy Babu'];
const COLLEGES = ['Digital University Kerala', 'CET Trivandrum', 'TKM College of Engineering', 'Model Engineering College', 'NIT Calicut'];
const ticket = i => `MMP4908${String(i + 1).padStart(4, '0')}`;
const person = i => ({
  ticketId: ticket(i), name: NAMES[i], email: `${NAMES[i].split(' ')[0].toLowerCase()}@example.com`, phone: `90000${String(i + 1).padStart(5, '0')}`,
  college: COLLEGES[i % COLLEGES.length],
});
NAMES.forEach((_, i) => registrations.set(ticket(i), { ...person(i), checkedInAt: '2026-11-07T09:30:00.000Z' }));

// ─── Questions: the document's four rounds, then one game of the other options ─
const q = (level, fields) => ({
  type: 'mcq', timeLimit: 10, points: 1000, image: null, video: null, ...level, ...fields, text: fields.text ?? '',
});
const spoken = (level, fields) => q(level, { type: 'short', options: [], timeLimit: 20, ...fields });
const picture = name => ({ mime: 'image/svg+xml', data: name });

const R1 = { level: 1, levelName: 'Indian Cinema', multiplier: 1, mode: 'standard', theme: 'marquee', cut: null };
const R2 = { level: 2, levelName: 'World Cinema', multiplier: 1, mode: 'standard', theme: 'curtain', cut: { rule: 'top', value: 5, ties: 'speed' } };
const R3 = { level: 3, levelName: 'Beyond the Frame', multiplier: 1, mode: 'passing', theme: 'noir', cut: null, afterMiss: 'close', manualResults: true };
const R4 = { level: 4, levelName: 'The Final Cut', multiplier: 1, mode: 'buzzer', theme: 'popcorn', cut: null, untimed: true, answerSeconds: 3, manualResults: true };

const MAIN = [
  q(R1, { id: 101, text: 'Who directed Drishyam (2013)?', options: ['Priyadarshan', 'Jeethu Joseph', 'Lijo Jose Pellissery', 'Anjali Menon'], correctAnswer: 'Jeethu Joseph', note: 'It was later remade in Tamil, Telugu, Kannada and Hindi.' }),
  q(R1, { id: 102, text: "Which film has the Oscar-winning song 'Naatu Naatu'?", options: ['Pushpa', 'RRR', 'KGF: Chapter 2', 'Baahubali 2'], correctAnswer: 'RRR' }),
  q(R1, { id: 103, type: 'tf', text: 'Sholay was released in 1975.', options: ['True', 'False'], correctAnswer: 'True' }),
  q(R2, { id: 201, text: 'Which was the first film not in English to win the Best Picture Oscar?', options: ['Roma', 'Parasite', 'Amour', 'Life Is Beautiful'], correctAnswer: 'Parasite' }),
  q(R2, { id: 202, text: 'Who directed Spirited Away?', options: ['Hayao Miyazaki', 'Akira Kurosawa', 'Isao Takahata', 'Makoto Shinkai'], correctAnswer: 'Hayao Miyazaki' }),
  q(R2, { id: 203, text: 'This drawing shows a scene from which 1997 film?', image: picture('titanic'), options: ['Titanic', 'Poseidon', 'Dunkirk', 'Cast Away'], correctAnswer: 'Titanic' }),
  spoken(R3, { id: 301, image: picture('fin'), correctAnswer: 'Jaws', accepted: 'Jaws (1975)' }),
  spoken(R3, { id: 302, text: "Which film has the line 'Mogambo khush hua'?", video: { url: 'audio', mime: 'audio/wav' }, correctAnswer: 'Mr. India', accepted: 'Mister India' }),
  spoken(R3, { id: 303, text: 'Name the film.', video: { url: 'video', mime: 'video/webm' }, correctAnswer: 'Life of Pi' }),
  spoken(R3, { id: 304, text: "Which Malayalam film was India's official Oscar entry for 2024?", correctAnswer: '2018: Everyone Is a Hero', accepted: '2018' }),
  spoken(R4, { id: 401, image: picture('moon'), correctAnswer: 'E.T. the Extra-Terrestrial', accepted: 'E.T.' }),
  spoken(R4, { id: 402, text: 'Who is the only actor to win the Best Actor Oscar three times?', correctAnswer: 'Daniel Day-Lewis' }),
];

const X1 = { level: 1, levelName: 'Warm-up', multiplier: 1, mode: 'standard', theme: 'blast', cut: { rule: 'top', value: 3, ties: 'speed' } };
const X2 = { level: 2, levelName: 'On Stage', multiplier: 1, mode: 'display', theme: 'pop', cut: null };
const X3 = { level: 3, levelName: 'Hot Seat', multiplier: 2, mode: 'passing', theme: 'arcade', cut: null, afterMiss: 'next' };
const X4 = { level: 4, levelName: 'Buzz Off', multiplier: 2, mode: 'buzzer', theme: 'circuit', cut: null, answerSeconds: 10 };

const OPTIONS = [
  q(X1, { id: 501, text: 'Who composed the music for Roja (1992)?', timeLimit: 15, options: ['Ilaiyaraaja', 'A. R. Rahman', 'M. Jayachandran', 'Deva'], correctAnswer: 'A. R. Rahman' }),
  q(X1, { id: 502, text: 'A question that turns out to have a mistake in it', timeLimit: 15, options: ['One', 'Two', 'Three', 'Four'], correctAnswer: 'One' }),
  q(X2, { id: 601, text: 'Name the three leads of Dil Chahta Hai.', timeLimit: 30, options: [], type: 'short', correctAnswer: 'Aamir Khan, Saif Ali Khan and Akshaye Khanna' }),
  spoken(X3, { id: 701, text: 'Who directed Pather Panchali?', correctAnswer: 'Satyajit Ray' }),
  spoken(X4, { id: 801, text: 'Which film won the first Academy Award for Best Picture?', correctAnswer: 'Wings' }),
  q(X1, { id: 901, backup: true, text: 'Which actor played the title role in Manichitrathazhu?', timeLimit: 15, options: ['Shobana', 'Revathi', 'Urvashi', 'Manju Warrier'], correctAnswer: 'Shobana' }),
  q(X1, { id: 902, backup: true, text: 'In which year was the first Indian talkie, Alam Ara, released?', timeLimit: 15, options: ['1913', '1931', '1947', '1955'], correctAnswer: '1931' }),
];

// ─── Recording ────────────────────────────────────────────────────────────────
const wait = ms => new Promise(r => setTimeout(r, ms));
const settle = () => wait(25);

const pool = [];
const poolIndex = new Map();
const ref = value => {
  const json = JSON.stringify(value ?? null);
  if (!poolIndex.has(json)) {
    poolIndex.set(json, pool.length);
    pool.push(json);
  }
  return poolIndex.get(json);
};

const steps = [];
const clients = {};     // screen, host, monitor, p1, p2, p3
const phones = {};      // p1, p2, p3 -> the player's socket, for the games they are featured in
const everyone = [];    // { name, socket, id } in join order
let host;
let game;
let currentGame = 'main';
let remount = new Set();

function makeClient(base) {
  const s = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.seen = [];
  s.onAny((event, ...args) => s.seen.push([event, ref(args[0])]));
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

const ask = (s, event, ...args) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no answer to ${event}`)), 4000);
  s.emit(event, ...args, r => { clearTimeout(t); resolve(r); });
});

async function act(action, data = null) {
  const r = await ask(host, 'host_action', action, data);
  if (r?.error) throw new Error(`${action}: ${r.error}`);
  return r;
}

// What a page gets when it opens or reloads at this moment (see game.js join_role, rejoin_game).
function snapshot() {
  const status = game.status();
  const shared = [
    ['server_info', ref({ lanAddresses: [], port: 3001 })],
    ['game_state', ref(engine.getState())],
    ['answer_count', ref({ answered: engine.answeredCount(), total: engine.connectedCount() })],
  ];
  const result = engine.state === 'leaderboard' && engine.lastResult ? [['question_result', ref(engine.lastResult)]] : [];
  const loaded = ['questions_loaded', ref(status.count ? status : { count: 0 })];
  const staffPlayers = ['players_list', ref(engine.getStaffPlayersList())];
  const snap = {
    screen: [...shared, ['players_list', ref(engine.getPlayersList())], ...result],
    host: [loaded, ['cut_pending', ref(engine.pendingCutView())], ['backups', ref(engine.backupList())], ['host_answer', ref(engine.hostAnswer())], ...shared, staffPlayers, ...result],
    monitor: [loaded, ['cut_pending', ref(engine.pendingCutView())], ...shared, staffPlayers],
  };
  for (const [device, phone] of Object.entries(phones)) {
    const p = phone.id ? engine.players[phone.id] : null;
    snap[device] = p ? ref({
      success: true,
      player: engine.privateView(p),
      gameState: engine.getState(),
      myAnswer: engine.answerFor(p),
      standing: engine.standingOf(p),
      roundEnd: engine.state === 'leaderboard' ? engine.lastResult?.roundEnd ?? null : null,
    }) : null;
  }
  return snap;
}

// One stop on the demo's timeline. press/label: what the coordinator pressed to get here.
async function step(chapter, title, body, { press, label, ack, jump, show, acks, drive, staff, tap } = {}) {
  await settle();
  const events = {};
  for (const [device, s] of Object.entries(clients)) events[device] = s.seen.splice(0);
  steps.push({
    game: currentGame, chapter, title, body, press, label, ack: ack ? ref(ack) : undefined, jump, show, acks, drive, staff, tap,
    remount: remount.size ? [...remount] : undefined,
    events, snap: snapshot(),
  });
  remount = new Set();
}

// Marks a phone tapping an option: the demo clicks the real button on that phone.
const tapOn = (device, option) => clients[device].seen.push(['__tap', ref(option)]);

async function join(base, index, device) {
  const s = await makeClient(base);
  const avatar = `${index % 2 ? 'b' : 'a'}:Demo${index}`;
  const r = await ask(s, 'join_game', { ticketId: ticket(index), name: '', avatar });
  if (!r.success) throw new Error(`join ${NAMES[index]}: ${r.error}`);
  const seat = { name: NAMES[index], socket: s, id: r.player.id, device };
  everyone.push(seat);
  if (device) {
    phones[device] = seat;
    clients[device] = s;
    remount.add(device);
  } else {
    s.removeAllListeners?.();
  }
  return seat;
}

const seatOf = name => everyone.find(p => p.name.startsWith(name));

// Moves the clock of the live question on, as if this much time had passed.
function elapse(seconds) {
  const passed = Date.now() - engine.questionStartTime;
  const shift = seconds * 1000 - passed;
  if (shift <= 0) return;
  engine.questionStartTime -= shift;
  if (engine.questionEndsAt) engine.questionEndsAt -= shift;
  if (engine.live?.turnStartedAt) engine.live.turnStartedAt -= shift;
}

// A small seeded generator: every recording plays out the same way.
let seed = 26;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const answer = async (seat, option) => {
  const r = await ask(seat.socket, 'submit_answer', option);
  if (r.error) throw new Error(`${seat.name}: ${r.error}`);
  if (seat.device) tapOn(seat.device, option);
};

// The crowd's answers to the live question: finalists are quick and right unless scripted otherwise.
function crowd(question, scripted) {
  const finalists = NAMES.slice(0, 5);
  const wrong = question.options.filter(o => o !== question.correctAnswer);
  return everyone.map(seat => {
    if (seat.name in scripted) return { seat, ...scripted[seat.name] };
    const isFinalist = finalists.includes(seat.name);
    const right = isFinalist || random() < 0.4;
    return {
      seat,
      option: right ? question.correctAnswer : wrong[Math.floor(random() * wrong.length)],
      at: isFinalist ? 2.4 + random() * 2 : 4.5 + random() * 4.5,
    };
  }).filter(a => a.option).sort((a, b) => a.at - b.at);
}

async function play(queue, until) {
  while (queue.length && queue[0].at <= until) {
    const next = queue.shift();
    elapse(next.at);
    await answer(next.seat, next.option);
  }
}

// ─── Game 1: the document's four rounds ───────────────────────────────────────
async function mainGame(base) {
  const A = 'Ananya Thomas';
  const R = 'Rohan Pillai';
  const M = 'Meera Kumar';
  const everyPhone = ['p1', 'p2', 'p3'];

  game.loadQuestions(MAIN, 'Coordinator', { id: 'main', name: 'Main set' });
  await step('door', 'The projector opens the lobby', 'The projector shows the QR code. Phones open the join page, and the coordinator sees the 12 questions loaded from the Main set.');

  await join(base, 0, 'p1');
  await join(base, 1, 'p2');
  for (let i = 2; i < 5; i++) await join(base, i);
  await join(base, 5, 'p3');
  for (let i = 6; i < NAMES.length; i++) await join(base, i);
  await step('door', '24 players are in', "Each player typed the ticket ID on their pass and picked a character. They appear under their registered name, so nobody can join as someone else.");

  // Round 1: standard
  await act('start_game');
  await step('r1', 'Round 1 opens', 'The intro sets the look for the round on the projector and every phone. This is a Standard round: everyone answers on their phone.', { press: 'start_game', label: 'Start game' });

  await act('start_question');
  await step('r1', 'Question 1 goes live', 'The server starts a 10-second timer. Phones get the four options but never the answer.', { press: 'start_question', label: 'Launch first question' });

  let queue = crowd(MAIN[0], { [A]: { option: 'Jeethu Joseph', at: 2.1 }, [R]: { option: 'Jeethu Joseph', at: 3.2 }, [M]: { option: 'Priyadarshan', at: 4 } });
  await play(queue, 5.5);
  await step('r1', 'Answers come in', "Ananya, Rohan and Meera have locked in. No phone says who is right until the reveal, and the counter on the projector and host console fills up.");

  await play(queue, 99);
  await act('end_question');
  await step('r1', 'The reveal', 'When the timer ends the projector shows the answer, how people voted and the top 10. Faster correct answers score more, and the first correct answer gets a bonus. The answer note appears on the phones.');

  await act('start_question');
  queue = crowd(MAIN[1], { [A]: { option: 'RRR', at: 2.8 }, [R]: { option: null }, [M]: { option: 'RRR', at: 6 } });
  await step('r1', 'Question 2', 'Standings stay on the phones between questions, and the coordinator moves on when ready.', { press: 'start_question', label: 'Next question' });
  await play(queue, 99);
  await act('end_question');
  await step('r1', 'Rohan was too slow', 'A player who misses the timer scores nothing, and their tie-break time grows by the full timer so skipping never helps.');

  await act('start_question');
  queue = crowd(MAIN[2], { [A]: { option: 'True', at: 2.5 }, [R]: { option: 'True', at: 2.2 }, [M]: { option: 'False', at: 5 } });
  await play(queue, 99);
  await step('r1', 'True or False', 'True / False questions use the same screens with two options.', { press: 'start_question', label: 'Next question' });
  await act('end_question');
  await step('r1', 'End of round 1', 'Nobody leaves after this round. The projector announces round 2 and phones confirm the player is through.');

  // Round 2: standard with a cut
  await act('start_question');
  await step('r2', 'Round 2 opens', 'A new look, and the intro warns that only the top 5 go through.', { press: 'start_question', label: 'Next question' });

  await act('start_question');
  queue = crowd(MAIN[3], { [A]: { option: 'Parasite', at: 2.6 }, [R]: { option: 'Parasite', at: 3 }, [M]: { option: 'Amour', at: 6 } });
  await step('r2', 'Question 4', 'A longer question and answer options still fit: the text shrinks to the space it has.', { press: 'start_question', label: 'Launch first question' });
  await play(queue, 99);
  await act('end_question');
  await step('r2', 'The line is on screen', 'From now on the reveal marks who is below the line, and each phone says whether that player is inside the top 5.');

  await act('start_question');
  queue = crowd(MAIN[4], { [A]: { option: 'Hayao Miyazaki', at: 2.2 }, [R]: { option: 'Hayao Miyazaki', at: 2.9 }, [M]: { option: 'Isao Takahata', at: 6.5 } });
  await play(queue, 99);
  await act('end_question');
  await step('r2', 'Question 5 revealed', 'Standings slide to their new order while the scores count up. Arrows show who moved.', { press: 'start_question', label: 'Next question' });

  await act('start_question');
  queue = crowd(MAIN[5], { [A]: { option: 'Titanic', at: 2.4 }, [R]: { option: 'Titanic', at: 3.4 }, [M]: { option: 'Titanic', at: 5 } });
  await step('r2', 'A picture question', 'The picture appears on the projector only. It is served from the game server once the question is live, so it cannot be seen early.', { press: 'start_question', label: 'Next question' });
  await play(queue, 99);
  await act('end_question');
  await step('r2', 'The cut is coming', 'The last question of the round ends and nobody is eliminated yet. The host console lists who goes through and who is out, with Keep and Remove buttons for each player.');

  const cut = await act('cut_confirm');
  await step('r2', 'The coordinator confirms the cut', '5 go through and 19 are out. Rohan and Ananya see that they made it. Meera sees her rank and score, and can stay to watch.', { press: 'cut_confirm', label: 'Confirm cut', ack: cut });

  const finalists = engine.activePlayers().map(p => p.name).sort();
  if (finalists.join() !== NAMES.slice(0, 5).sort().join()) throw new Error(`Unexpected finalists: ${finalists}`);

  // Round 3: turns, results kept by hand
  await act('start_question');
  await step('r3', 'Round 3 opens', 'A Turns round kept by hand. Each question goes to the next finalist, and the system records no points. The quiz master keeps the scores.', { press: 'start_question', label: 'Next question' });

  await act('start_question');
  await step('r3', 'Ananya has the question', "Her phone says to answer out loud and offers Pass. Everyone else sees whose turn it is. Only the host console shows the answer, with Correct, Wrong, Pass and No answer.", { press: 'start_question', label: 'Launch first question' });

  await act('judge_answer', { verdict: 'correct' });
  await step('r3', 'The coordinator marks it correct', 'The projector shows just the answer, with no standings. Phones point back to the big screen.', { press: 'judge_answer', label: 'Correct' });

  await act('start_question');
  await step('r3', 'An audio clip plays first', 'The clip plays through the projector. Phones say Listen up, and nothing else starts until the coordinator presses Start question. Play, Pause and Replay work on the host console.', { press: 'start_question', label: 'Next question' });

  await act('start_question');
  await step('r3', "Rohan's turn", 'The clip is done and the question and timer start. The first go moves to the next finalist with each question.', { press: 'start_question', label: 'Start question' });

  await ask(seatOf(R).socket, 'pass_turn');
  await step('r3', 'Rohan presses Pass', 'This round is set to "Question closes", so a pass goes straight to the answer. Set it to "Next player" and it would move on.');

  await act('start_question');
  await step('r3', 'A video clip', 'Video works the same way as audio. It plays full size on the projector and phones say to watch.', { press: 'start_question', label: 'Next question' });

  await act('start_question');
  await act('judge_answer', { verdict: 'wrong' });
  await step('r3', 'A wrong answer', "Diya had this one and got it wrong. The question closes and the answer shows. The system keeps no record, so the quiz master notes it.", { press: 'start_question', label: 'Start question' });

  await act('start_question');
  await step('r3', 'A text question', "Arjun's turn. The host console also shows other accepted answers, here the short title.", { press: 'start_question', label: 'Next question' });

  await act('end_question');
  await step('r3', 'Show answer', 'The coordinator can reveal the answer at any time and move on, whatever the player said.', { press: 'end_question', label: 'Show answer' });

  // Round 4: buzzer, results kept by hand
  await act('start_question');
  await step('r4', 'The final round opens', 'A Buzzer round kept by hand with no time limit. Every finalist can press once and nobody locks.', { press: 'start_question', label: 'Next question' });

  await act('start_question');
  await step('r4', 'Buzzers open', 'Finalists get a big Buzz button, and the eliminated players keep watching. There is no timer, so the coordinator closes each question.', { press: 'start_question', label: 'Launch first question' });

  await ask(seatOf(R).socket, 'buzz');
  await step('r4', 'Rohan buzzes first', 'The server decides the order by when each press arrives. His phone shows his place straight away.');

  for (const name of ['Ananya Thomas', 'Kiran Joseph']) await ask(seatOf(name).socket, 'buzz');
  await step('r4', 'The order builds up', 'Everyone sees the same order on the projector, and the host console lists it next to the answer. The quiz master takes answers in that order.');

  await act('end_question');
  await step('r4', 'The answer', 'The coordinator presses Show answer when the quiz master is ready.', { press: 'end_question', label: 'Show answer' });

  await act('start_question');
  for (const name of ['Ananya Thomas', 'Arjun Varghese', 'Rohan Pillai', 'Diya Menon', 'Kiran Joseph']) await ask(seatOf(name).socket, 'buzz');
  await step('r4', 'Last question', 'All five buzz. Ananya was first this time.', { press: 'start_question', label: 'Next question' });

  await act('end_question');
  await step('r4', 'The last answer', 'The final round is over.', { press: 'end_question', label: 'Show answer' });

  await act('start_question');
  await step('r4', "That's a wrap", 'The final was kept by hand, so the game shows the finalists without ranks. The quiz master announces the winners.', { press: 'start_question', label: 'Show final results' });
}

// ─── Game 2: the other options ────────────────────────────────────────────────
async function optionsGame(base) {
  currentGame = 'options';
  await act('reset_game');
  await settle();
  everyone.length = 0;
  for (const s of ['p1', 'p2', 'p3']) { delete phones[s]; delete clients[s]; }
  game.loadQuestions(OPTIONS, 'Coordinator', { id: 'trial', name: 'Trial set' });

  await join(base, 0, 'p1');          // Ananya
  await join(base, 1, 'p2');          // Rohan
  await join(base, 22, 'p3');         // Joel
  await join(base, 19);               // Riya
  await join(base, 7);                // Sneha
  await join(base, 18);               // Hari
  const [ananya, rohan, joel, riya, sneha, hari] = everyone;
  await step('extra', 'A smaller game with a scored final', 'This second game uses a set up differently, to show everything your four rounds do not use. Each round has a different look too.', { jump: true, show: ['screen', 'host', 'p1', 'p2', 'p3'] });

  await act('start_game');
  await act('start_question');
  const options = 'A. R. Rahman';
  elapse(2); await answer(ananya, options);
  elapse(3); await answer(riya, options);
  elapse(4); await answer(rohan, options); await answer(sneha, options);
  elapse(6); await answer(hari, 'Deva');
  await ask(joel.socket, 'screen', { hidden: true });
  engine.players[joel.id].awaySince -= 8000; // as if away for 8 seconds
  await ask(joel.socket, 'screen', { hidden: false });
  await wait(1100); // staff lists refresh once a second
  await step('extra', 'A flag for staff', 'Joel left the quiz page during the question. The host console and the live monitor flag it, and answers that come in under 1.5 seconds are flagged too. Flags are hints for an invigilator. Nothing happens automatically.', { press: 'start_question', label: 'Launch first question', show: ['monitor', 'host', 'p3'] });

  await act('end_question');
  await step('extra', 'A smaller field on the reveal', 'The standings change shape with the field: rows for a crowd, a full list for 10 or fewer, and big cards for the last 5. This round uses the Blast look.');

  await act('disqualify_player', { playerId: joel.id, reason: 'Using a second phone' });
  await step('extra', 'Disqualifying a player', 'An invigilator confirms it and the coordinator presses DQ with a reason. The player loses their rank and it stays on record. Eliminate is the gentler option: the player keeps a rank.', { press: 'disqualify_player', label: 'Disqualify Joel', show: ['host', 'p3', 'monitor'] });

  await act('start_question');
  await step('extra', 'A question with a mistake', 'The coordinator can cancel a live question or a playing clip.', { press: 'start_question', label: 'Next question' });

  await act('cancel_question');
  await step('extra', 'Cancelled', 'Answers are dropped and it counts for nobody. The host console offers the set\'s backup questions to play in its place.', { press: 'cancel_question', label: 'Cancel question' });

  await act('use_backup', { id: 901 });
  await step('extra', 'A backup replaces it', 'The backup plays in the same round and starts straight away.', { press: 'use_backup', label: 'Play backup' });
  elapse(2); await answer(ananya, 'Shobana');
  elapse(3); await answer(riya, 'Shobana');
  elapse(4); await answer(rohan, 'Shobana'); await answer(sneha, 'Shobana');
  elapse(7); await answer(hari, 'Urvashi');
  await act('end_question');
  await step('extra', 'A tie at the cut line', 'Top 3 go through, and Rohan and Sneha are level for third place. The host console offers Sudden death and lists the tied players.');

  await act('sudden_death', { playerIds: [rohan.id, sneha.id], questionId: 902 });
  await step('extra', 'Sudden death', 'Only the tied players answer a spare question. Other phones watch. It decides the order and changes no scores. With a spoken spare, the two of them would buzz instead.', { press: 'sudden_death', label: 'Start sudden death' });

  elapse(2); await answer(rohan, '1931');
  elapse(3); await answer(sneha, '1931');
  await act('end_question');
  await step('extra', 'Rohan wins the tie-break', 'The fastest correct answer takes the higher place, and the proposed cut updates to match.');

  await act('cut_confirm');
  await act('start_question');
  await step('extra', 'Show only', 'A round type your document does not use: the projector shows the question, and phones just say to watch. Nothing is collected.', { press: 'cut_confirm', label: 'Confirm cut' });

  await act('start_question');
  await step('extra', 'A Show only question', 'The coordinator presses Show answer when the room is ready.', { press: 'start_question', label: 'Launch first question' });

  await act('end_question');
  await act('start_question');
  await step('extra', 'A scored Turns round', 'The same Turns round with points kept by the system. After a pass the question moves to the next player for half the points.', { press: 'end_question', label: 'Show answer' });

  await act('start_question');
  await step('extra', 'Answer or pass', 'Ananya holds the question. She can say the answer or pass. Rohan waits and is told it may reach him.', { press: 'start_question', label: 'Launch first question' });

  await ask(ananya.socket, 'pass_turn');
  await step('extra', 'Passed on', "Rohan's turn is half the timer, and his phone tells him to say his answer.");

  await act('judge_answer', { verdict: 'correct' });
  await step('extra', 'Stolen', 'A correct answer after a pass earns half the points. The projector shows how the question went, player by player.', { press: 'judge_answer', label: 'Correct' });

  await act('toggle_scoreboard');
  await step('extra', 'The scoreboard', 'Between questions the coordinator can put a round-by-round table on the projector.', { press: 'toggle_scoreboard', label: 'Show scoreboard' });

  await act('toggle_scoreboard');
  await act('start_question');
  await act('set_hide_final_standings', { hide: true });
  await step('extra', 'A scored Buzzer round', 'The first buzz takes the question and the others lock. With "Hide standings in the final round" ticked, the winner stays secret until the end.', { press: 'start_question', label: 'Next question' });

  await act('start_question');
  await step('extra', 'Buzzers open, with a timer', 'A timed buzzer round shows the clock. It stops while someone answers.', { press: 'start_question', label: 'Launch first question' });

  await ask(ananya.socket, 'buzz');
  await step('extra', 'First to buzz answers', 'Ananya says her answer and the other buzzers stay locked. There are no options in this round, so the coordinator marks it.');

  await act('judge_answer', { verdict: 'wrong' });
  await step('extra', 'Wrong: locked out', 'A wrong answer costs half the points and locks that player out for this question. The buzzers reopen with the time that was left.', { press: 'judge_answer', label: 'Wrong' });

  await ask(rohan.socket, 'buzz');
  await step('extra', 'Rohan buzzes next', 'The buzzers reopened for everyone who has not tried, and Rohan took it.');

  await act('judge_answer', { verdict: 'correct' });
  await step('extra', 'Correct: the question ends', 'The projector keeps the standings hidden in the final round.', { press: 'judge_answer', label: 'Correct' });

  await act('start_question');
  await step('extra', 'The podium', 'A scored final ends with the podium, and every phone shows its rank. A disqualified player sees Game over with no rank.', { press: 'start_question', label: 'Show final results' });
}

// ─── Screens with no live game behind them ────────────────────────────────────
// The staff pages run on the demo's own sample data (frontend/demo/mockApi.ts).
function staffSteps() {
  const staff = (role, tab, vault) => ({ role, tab, vault });
  const before = [
    { chapter: 'prep', title: 'Staff sign in', body: 'Every staff member has their own login, and the role decides what they see. The demo skips the password.', show: ['staff'], staff: staff(null) },
    { chapter: 'prep', title: 'Quiz master: question sets', body: 'Each set is encrypted with its own PIN. Admins can load a set with its PIN but cannot read it.', show: ['staff'], staff: staff('quizmaster', 'questions') },
    { chapter: 'prep', title: 'Quiz master: the four rounds', body: 'This is the Main set used in this demo. Round 1 is a Standard round. Try the level tabs, Edit, or the set tools.', show: ['staff'], staff: staff('quizmaster', 'questions', true), drive: { staff: [{ scroll: '.tabs[aria-label="Levels"]' }] } },
    { chapter: 'prep', title: 'Round 3 settings', body: 'Beyond the Frame is a Turns round where "After a pass or wrong answer" is set to Question closes and "Results kept by hand" is ticked.', show: ['staff'], staff: staff('quizmaster', 'questions', true), drive: { staff: [{ click: 'Beyond the Frame' }, { scroll: '.tabs[aria-label="Levels"]' }] } },
    { chapter: 'prep', title: 'Round 4 settings', body: 'The Final Cut is a Buzzer round with no time limit and "Results kept by hand" ticked.', show: ['staff'], staff: staff('quizmaster', 'questions', true), drive: { staff: [{ click: 'The Final Cut' }, { scroll: '.tabs[aria-label="Levels"]' }] } },
    { chapter: 'prep', title: 'Admin: participants', body: 'Upload the MakeMyPass CSV. Re-importing updates details and never clears a check-in.', show: ['staff'], staff: staff('admin', 'participants') },
    { chapter: 'prep', title: 'Admin: staff accounts', body: 'Admins create accounts for each role. Coordinators can add volunteers only.', show: ['staff'], staff: staff('admin', 'staff') },
    { chapter: 'door', title: 'Volunteer: scanning a pass', body: 'A volunteer scans the QR code on the pass, or types the ticket ID. The camera is off in this demo, so the ticket is typed.', show: ['staffPhone'], staff: staff('volunteer', 'scan'), drive: { staffPhone: [{ type: ['input[aria-label="Ticket ID"]', 'MMP49080025'] }, { click: 'Check' }, { scroll: '.result-card' }] } },
    { chapter: 'door', title: 'Volunteer: already admitted', body: 'A ticket used twice is flagged with the time and who admitted it, so a shared pass stands out.', show: ['staffPhone'], staff: staff('volunteer', 'scan'), drive: { staffPhone: [{ type: ['input[aria-label="Ticket ID"]', 'MMP49080002'] }, { click: 'Check' }, { scroll: '.result-card' }] } },
    { chapter: 'door', title: 'Admin: arrivals', body: 'The Overview page counts arrivals and shows the game server. Results and the activity log download from here after the game.', show: ['staff'], staff: staff('admin', 'overview') },
    { chapter: 'door', title: 'Coordinator: live event', body: 'The coordinator opens the host console from here. The live monitor below is what volunteers keep open during the game.', show: ['staff'], staff: staff('coordinator', 'live') },
  ];
  const after = [
    { chapter: 'extra', title: 'A wrong ticket', body: 'Only admitted tickets can play. An unknown ticket gets a clear message, and repeated guesses are slowed down.', show: ['p1'], phoneOnly: true,
      acks: { p1: { error: 'Ticket not found — check the ID on your pass' } }, drive: { p1: [{ type: ['#player-ticket', 'MMP49089999'] }, { click: "Let's play!" }] } },
    { chapter: 'extra', title: 'Same ticket, new phone', body: "If a phone dies, the player can take their seat back on another by proving the ticket is theirs with the last 4 digits of their registered phone.", show: ['p1'], phoneOnly: true,
      acks: { p1: { needsVerify: true, error: 'This ticket is already in the game. To continue on this device, enter the last 4 digits of the phone number you registered with.' } }, drive: { p1: [{ type: ['#player-ticket', 'MMP49080002'] }, { click: "Let's play!" }] } },
  ];
  return { before, after };
}

(async () => {
  const server = http.createServer();
  const io = new Server(server);
  game = createGame(io, { serverInfo: () => ({ lanAddresses: [], port: 3001 }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const token = await auth.createSession(staffRow);
  host = await makeClient(base);
  await ask(host, 'join_role', 'host', token);
  clients.host = host;
  clients.screen = await makeClient(base);
  await ask(clients.screen, 'join_role', 'bigscreen');
  clients.monitor = await makeClient(base);
  await ask(clients.monitor, 'join_role', 'monitor', token);
  await settle();
  for (const s of Object.values(clients)) s.seen.length = 0;

  await mainGame(base);
  await optionsGame(base);

  const { before, after } = staffSteps();
  const empty = { screen: [], host: [], monitor: [], p1: [], p2: [], p3: [] };
  // Staff pages see the game as it stands in the lobby. A recorded step after one of them, or at
  // the start of a game, has no earlier events to build on, so the demo loads it fresh.
  const staticStep = s => ({ game: 'main', ...s, static: true, jump: true, events: empty, snap: { ...steps[0].snap, p1: null } });
  const timeline = [...before.map(staticStep), ...steps, ...after.map(staticStep)];
  timeline.forEach((s, i) => { if (timeline[i - 1]?.static || s.game !== timeline[i - 1]?.game) s.jump = true; });

  const bank = { name: 'Main set', questions: MAIN, levels: [R1, R2, R3, R4] };
  const people = [...NAMES.map((_, i) => person(i)),
    { ticketId: 'MMP49080025', name: 'Theertha Babu', email: 'theertha@example.com', phone: '9000000025', college: COLLEGES[0] },
    { ticketId: 'MMP49080026', name: 'Yadu Krishnan', email: 'yadu@example.com', phone: '9000000026', college: COLLEGES[1] }];

  fs.writeFileSync(OUTPUT, JSON.stringify({ pool, steps: timeline, bank, people }));
  console.log(`Recorded ${timeline.length} steps (${(fs.statSync(OUTPUT).size / 1048576).toFixed(1)} MB) to ${path.relative(process.cwd(), OUTPUT)}`);
  process.exit(0);
})().catch(err => {
  console.error(`Recording failed: ${err.stack}`);
  process.exit(1);
});
