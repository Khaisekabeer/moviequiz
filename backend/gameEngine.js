const { randomUUID, randomBytes } = require('crypto');

// Answers arriving this long after the deadline are still accepted (network latency).
const ANSWER_GRACE_MS = 1000;
const MAX_NAME_LENGTH = 40; // players appear under their registered name
// A correct answer faster than this on a question of 10 s or more is flagged for staff to review.
const FAST_CORRECT_MS = 1500;
// Avatar picked on the phone: style (a = cartoon person, b = robot) and a seed, drawn in the browser.
const AVATAR_RE = /^[ab]:[A-Za-z0-9]{1,16}$/;
// Level themes; a level without one gets the next in this order by its round.
const THEME_ORDER = ['marquee', 'curtain', 'noir', 'popcorn'];
// Scoring rules the coordinator can switch off in the lobby. These defaults are the original rules.
const DEFAULT_RULES = {
  multiplier: true,  // each level's points multiplier
  firstBlood: true,  // +20% of base for the first correct answer on each question
  streak: true,      // +10% of base for each correct answer once a streak of 3 is reached
  roundReset: false, // every player starts each round at 0 points (and the cut uses round points)
};

// Round types a level can be, set by the quiz master. In a buzzer or passing round one player
// at a time holds the question; see "Buzzer and passing rounds" below.
// 'display' is show only: the projector shows each question, and the quiz master runs the answers
// and the scores by hand, so the game collects and records nothing.
const ROUND_MODES = ['standard', 'buzzer', 'passing', 'display'];
// Buzzer: the first to buzz gets this long to answer. A wrong answer or running out of time costs
// this share of the question's points and locks the player out; the buzzers then reopen.
const BUZZ_ANSWER_SECONDS = 10;
const BUZZ_PENALTY = 0.5;
// Passing: after the first player, a turn is this share of the timer (at least MIN_TURN_SECONDS)
// and a correct answer earns this share of the points. A question reaches this many players at most.
const PASS_TURN_SHARE = 0.5;
const PASS_POINTS_SHARE = 0.5;
const PASS_MAX_TURNS = 6;
const MIN_TURN_SECONDS = 5;

// A spoken question has no options: the player says the answer and the coordinator marks it.
const isSpoken = q => q?.type === 'short';

// What other clients may see about a player (never the rejoin token or ticket).
function publicPlayer(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, team: p.team, score: p.score, streak: p.streak, connected: p.connected, status: p.status, time: p.totalResponseTime, lastTime: p.lastResponseTime, rounds: p.roundPoints };
}

// Standings: higher score first; on a tie, whoever won a sudden death, then less total answer time
// (a skipped question counts as its full timer, so skipping never helps).
const byStanding = (a, b) => (b.score - a.score) || (b.tieBreak - a.tieBreak) || (a.totalResponseTime - b.totalResponseTime);

// How a level's cut reads on screens and in the records.
function cutLabel({ rule, value }) {
  switch (rule) {
    case 'top': return `Top ${value} go through`;
    case 'percent': return `Top ${value}% go through`;
    case 'min_score': return `${value}+ points to go through`;
    case 'bottom': return `Bottom ${value} are out`;
    case 'min_correct': return `${value}+ correct answers to go through`;
    default: return '';
  }
}

class GameEngine {
  constructor() {
    this.loaded = [];
    // Coordinator's choice, kept across resets: hide the standings during the last round so the
    // winner is only revealed at the final results.
    this.hideFinalStandings = false;
    // Scoring rules, chosen by the coordinator before the game starts; kept across resets.
    this.rules = { ...DEFAULT_RULES };
    this.reset();
  }

  reset() {
    this.setQuestions(this.loaded); // backups swapped into the last game go back on the shelf
    this.gameId = randomUUID(); // games.id in Supabase
    this.state = 'lobby'; // lobby, intro, question, leaderboard, podium
    // participantId -> player (see addPlayer)
    this.players = {};
    this.tokens = {};  // rejoin token -> participantId
    this.sockets = {}; // socketId -> participantId
    this.currentQuestionIndex = -1; // index of the question being asked, or the next one to ask
    this.currentLevel = this.questions[0]?.level || 1;
    this.questionStartTime = null;
    this.questionEndsAt = null;
    this.answers = {};    // participantId -> { participantId, answer, time, isCorrect, pointsEarned, badge }
    this.firstBloodAwarded = false;
    this.timerMax = null; // length of the running timer in seconds (a question, or one player's turn)
    this.live = null;     // the buzzer or passing question in progress (see beginTurns)
    this.sd = null;       // the sudden death in progress (see startSuddenDeath)
    this.showScoreboard = false; // coordinator put the round-by-round table on the projector
    this.lastResult = null; // reveal data for the last question, resent to screens that (re)connect
    // End-of-level cut waiting for the coordinator: { level, info, keep: Set, out: Set }.
    this.pendingCut = null;
  }

  // Backup questions are held apart: they are played only when the host swaps one in.
  setQuestions(questions) {
    this.loaded = questions;
    this.questions = questions.filter(q => !q.backup);
    this.backups = questions.filter(q => q.backup);
    this.backupsUsed = new Set();
  }

  // For the host console only: the text, never the answer.
  backupList() {
    return this.backups.map(q => ({ id: q.id, type: q.type, text: q.text || 'Picture or clip question', used: this.backupsUsed.has(q.id) }));
  }

  // Replaces the cancelled question with a backup in the same round, and starts it.
  useBackup(id) {
    if (this.state !== 'leaderboard' || !this.lastResult?.backupAllowed) return { error: 'A backup can replace a cancelled question only' };
    const backup = this.backups.find(q => q.id === id && !this.backupsUsed.has(q.id));
    if (!backup) return { error: 'That backup is not available' };
    const index = this.currentQuestionIndex - 1;
    const { level, levelName, multiplier, cut, theme, mode, afterMiss, scoring, untimed, answerSeconds, resetScores, manualResults } = this.questions[index];
    this.questions[index] = { ...backup, level, levelName, multiplier, cut, theme, mode, afterMiss, scoring, untimed, answerSeconds, resetScores, manualResults };
    this.backupsUsed.add(id);
    this.currentQuestionIndex = index;
    this.pendingCut = null; // proposed again when this round really ends
    this.lastResult = null;
    return this.startQuestion();
  }

  // Levels come with the questions (levelName, multiplier, cut, theme set by the quiz master).
  // The round number is the level's place among the levels in this game, so gaps don't show.
  levelNumbers() {
    return [...new Set(this.questions.map(q => q.level || 1))];
  }

  levelInfo(level) {
    const q = this.questions.find(x => (x.level || 1) === level);
    const multiplier = Number(q?.multiplier);
    const levels = this.levelNumbers();
    const round = Math.max(1, levels.indexOf(level) + 1);
    const isLast = levels[levels.length - 1] === level;
    const rawCut = q?.cut?.rule && Number.isFinite(Number(q.cut.value))
      ? { rule: q.cut.rule, value: Number(q.cut.value), ties: q.cut.ties === 'include' ? 'include' : 'speed' }
      : null;
    return {
      number: level,
      round,
      name: q?.levelName || `Level ${level}`,
      multiplier: multiplier > 0 ? multiplier : 1,
      // The cut at the end of this level (none on the final level).
      cut: rawCut && !isLast ? { ...rawCut, label: cutLabel(rawCut) } : null,
      theme: q?.theme || THEME_ORDER[(round - 1) % THEME_ORDER.length],
      mode: ROUND_MODES.includes(q?.mode) ? q.mode : 'standard',
      // Turns round: after a pass or wrong answer the question goes on, or closes.
      afterMiss: q?.afterMiss === 'close' ? 'close' : 'next',
      // Fixed points for a turn ({ correct, wrong, timeout }), or null for the question's own points.
      scoring: q?.scoring ?? null,
      untimed: q?.untimed === true,
      answerSeconds: Number(q?.answerSeconds) > 0 ? Number(q.answerSeconds) : BUZZ_ANSWER_SECONDS,
      resetScores: q?.resetScores === true,
      // Results kept by hand: the round runs, but no points, standings or winners are recorded.
      manualResults: q?.manualResults === true || q?.mode === 'display',
    };
  }

  currentQuestion() {
    return this.sd?.question ?? this.questions[this.currentQuestionIndex];
  }

  playerBySocket(socketId) {
    return this.players[this.sockets[socketId]];
  }

  playerByTicket(ticketId) {
    return ticketId ? Object.values(this.players).find(p => p.ticketId === ticketId) : undefined;
  }

  // ticket: { ticketId, fullName } when check-in is required, otherwise null.
  addPlayer(socketId, rawName, rawTeam, ticket = null, rawAvatar = null) {
    if (this.sockets[socketId]) return { error: 'Already joined' };
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) return { error: `Name must be 1-${MAX_NAME_LENGTH} characters` };
    const team = typeof rawTeam === 'string' ? rawTeam.trim().slice(0, 30) : '';

    if (ticket && this.playerByTicket(ticket.ticketId)) return { error: 'This ticket is already playing on another device' };
    const isDuplicate = Object.values(this.players).some(p => p.name.toLowerCase() === name.toLowerCase());
    if (isDuplicate && !ticket) return { error: 'That display name is taken — pick another' };

    const player = {
      id: randomUUID(), // participants.id in Supabase
      token: randomBytes(16).toString('hex'),
      socketId,
      connected: true,
      ticketId: ticket?.ticketId ?? null,
      fullName: ticket?.fullName ?? null,
      // Two people can register with the same name: the end of the ticket tells them apart.
      name: isDuplicate ? `${name.slice(0, MAX_NAME_LENGTH - 7)} #${ticket.ticketId.slice(-4)}` : name,
      team,
      avatar: typeof rawAvatar === 'string' && AVATAR_RE.test(rawAvatar) ? rawAvatar : `b:${randomBytes(4).toString('hex')}`,
      score: 0,
      streak: 0,
      totalResponseTime: 0,
      lastResponseTime: 0, // the latest question only, shown on the projector
      levelCorrect: {}, // level number -> correct answers in that level (for "min correct" cuts)
      roundPoints: {},  // round name -> points in that round, for the final scoreboard
      tieBreak: 0,      // sudden deaths won since scores last started at 0
      answers: { correct: 0, wrong: 0, skipped: 0 }, // over the whole game, for the dashboard
      status: 'active', // active | eliminated | disqualified
      exit: null,       // { reason, level, round, levelName, rank, score, note, staffId } once out
      // Indicators for staff (never decisive on their own): leaving the quiz screen during a
      // question, very fast correct answers, reconnects.
      flags: { away: 0, awayMs: 0, fastCorrect: 0, reconnects: 0 },
      awaySince: null,
    };
    this.players[player.id] = player;
    this.tokens[player.token] = player.id;
    this.sockets[socketId] = player.id;
    return { success: true, player: this.privateView(player), token: player.token };
  }

  // Reattach a returning player (page refresh, Wi-Fi drop) to their new socket.
  rejoin(socketId, token) {
    const player = this.players[this.tokens[token]];
    if (typeof token !== 'string' || !player) return { error: 'Session not found' };
    const previousSocketId = player.socketId;
    if (previousSocketId) delete this.sockets[previousSocketId];
    player.socketId = socketId;
    player.connected = true;
    if (this.state !== 'lobby') player.flags.reconnects += 1;
    this.sockets[socketId] = player.id;
    return { success: true, player: this.privateView(player), previousSocketId };
  }

  // A checked-in player on a new device (lost the rejoin token) reclaims their seat by ticket,
  // but only while their old device is disconnected.
  reclaimByTicket(socketId, ticketId) {
    const player = this.playerByTicket(ticketId);
    if (!player) return null;
    if (player.connected) return { error: 'This ticket is already playing on another device' };
    const result = this.rejoin(socketId, player.token);
    return result.error ? result : { ...result, token: player.token };
  }

  disconnect(socketId) {
    const player = this.playerBySocket(socketId);
    delete this.sockets[socketId];
    if (!player || player.socketId !== socketId) return null;
    player.socketId = null;
    player.connected = false;
    this.closeAway(player);
    return player;
  }

  // Lobby only: take a player out entirely (nothing has been recorded yet).
  removePlayer(participantId) {
    const player = this.players[participantId];
    if (!player) return null;
    delete this.players[participantId];
    delete this.tokens[player.token];
    if (player.socketId) delete this.sockets[player.socketId];
    return player;
  }

  // ─── Elimination ────────────────────────────────────────────────────────────
  activePlayers() {
    return Object.values(this.players).filter(p => p.status === 'active');
  }

  // Who would go through if the level's cut were applied now. Rules (set per level):
  //   top N · top X% · bottom N out · score of at least X · at least K correct in this level.
  // Ties at the line: 'speed' = the faster player wins; 'include' = everyone tied goes through.
  computeCut(levelNumber, ties = null) {
    const info = this.levelInfo(levelNumber);
    const cut = info.cut;
    if (!cut) return null;
    const ranked = this.activePlayers().sort(byStanding);
    const byCount = n => {
      const count = Math.max(0, Math.min(ranked.length, Math.floor(n)));
      if (count >= ranked.length) return ranked;
      if (count === 0) return [];
      if ((ties ?? cut.ties) === 'include') {
        const line = ranked[count - 1].score;
        return ranked.filter(p => p.score >= line);
      }
      return ranked.slice(0, count);
    };
    let through;
    switch (cut.rule) {
      case 'top': through = byCount(cut.value); break;
      case 'percent': through = byCount(Math.ceil((ranked.length * cut.value) / 100)); break;
      case 'bottom': through = byCount(ranked.length - cut.value); break;
      case 'min_score': through = ranked.filter(p => p.score >= cut.value); break;
      case 'min_correct': through = ranked.filter(p => (p.levelCorrect[levelNumber] || 0) >= cut.value); break;
      default: through = ranked;
    }
    const keep = new Set(through.map(p => p.id));
    return { info, ranked, keep, out: ranked.filter(p => !keep.has(p.id)).map(p => p.id) };
  }

  // The proposed cut for the coordinator to review (staff only).
  pendingCutView() {
    const pc = this.pendingCut;
    if (!pc) return null;
    const ranked = this.activePlayers().sort(byStanding);
    const row = (p, i) => ({
      id: p.id, name: p.name, avatar: p.avatar, ticketId: p.ticketId, rank: i + 1, score: p.score,
      correctInLevel: p.levelCorrect[pc.level] || 0,
    });
    const rows = ranked.map(row);
    return {
      level: pc.level,
      round: pc.info.round,
      levelName: pc.info.name,
      label: pc.info.cut.label,
      ties: pc.info.cut.ties,
      advance: rows.filter(r => pc.keep.has(r.id)),
      out: rows.filter(r => pc.out.has(r.id)),
    };
  }

  // Coordinator moves a player across the line before confirming.
  adjustCut(participantId, keep) {
    const pc = this.pendingCut;
    if (!pc) return { error: 'There is no cut waiting' };
    if (!this.players[participantId] || this.players[participantId].status !== 'active') return { error: 'Player not found' };
    if (keep) { pc.out.delete(participantId); pc.keep.add(participantId); } else { pc.keep.delete(participantId); pc.out.add(participantId); }
    return { success: true };
  }

  // Apply the cut: everyone in `out` is eliminated with their rank at that moment.
  confirmCut(staffId = null) {
    const pc = this.pendingCut;
    if (!pc) return { error: 'There is no cut waiting' };
    const ranked = this.activePlayers().sort(byStanding);
    const before = new Map(ranked.map((p, i) => [p.id, { rank: i + 1, score: p.score }]));
    const out = ranked.filter(p => pc.out.has(p.id));
    for (const p of out) {
      this.closeAway(p);
      p.status = 'eliminated';
      p.exit = {
        reason: 'cut', level: pc.level, round: pc.info.round, levelName: pc.info.name,
        rank: before.get(p.id).rank, score: p.score, note: `${pc.info.cut.label} after ${pc.info.name}`, staffId,
      };
    }
    this.pendingCut = null;
    const elimination = {
      level: pc.level, round: pc.info.round, levelName: pc.info.name, label: pc.info.cut.label,
      advanced: ranked.length - out.length,
      eliminated: out.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, rank: p.exit.rank, score: p.score })),
    };
    // Survivors move up; prevRank lets the projector animate the change.
    const leaderboard = this.activePlayers().sort(byStanding)
      .map(p => ({ ...publicPlayer(p), prevRank: before.get(p.id).rank, prevScore: p.score }));
    const roundEnd = { round: pc.info.round, levelName: pc.info.name, isFinal: false, cutPending: false, cutLabel: pc.info.cut.label, eliminated: out.length };
    this.lastResult = { ...this.lastResult, leaderboard, elimination, pendingCut: null, atRisk: [], roundEnd, backupAllowed: false };
    return { success: true, elimination, out, leaderboard, roundEnd };
  }

  // Coordinator eliminates one player directly (e.g. a panel decision). Not a disqualification:
  // they keep a rank among the eliminated.
  eliminate(participantId, note, staffId = null) {
    const player = this.players[participantId];
    if (!player) return { error: 'Player not found' };
    if (player.status !== 'active') return { error: 'That player is already out' };
    const info = this.levelInfo(this.currentLevel);
    const rank = this.activePlayers().sort(byStanding).indexOf(player) + 1;
    this.closeAway(player);
    if (this.state === 'question') delete this.answers[player.id];
    this.pendingCut?.keep.delete(player.id);
    this.pendingCut?.out.delete(player.id);
    player.status = 'eliminated';
    player.exit = {
      reason: 'manual', level: info.number, round: info.round, levelName: info.name,
      rank, score: player.score, note: note || 'Eliminated by the quiz host', staffId,
    };
    return { success: true, player, moved: this.releaseTurn(player) };
  }

  // Staff action (malpractice etc.): the player is out at once, keeps no rank, and an answer
  // they gave to the live question is discarded.
  disqualify(participantId, note, staffId = null) {
    const player = this.players[participantId];
    if (!player) return { error: 'Player not found' };
    if (player.status === 'disqualified') return { error: 'Already disqualified' };
    const info = this.levelInfo(this.currentLevel);
    this.closeAway(player);
    if (this.state === 'question') delete this.answers[player.id];
    this.pendingCut?.keep.delete(player.id);
    this.pendingCut?.out.delete(player.id);
    player.status = 'disqualified';
    player.exit = {
      reason: 'disqualified',
      level: info.number,
      round: info.round,
      levelName: info.name,
      rank: null,
      score: player.score,
      note: note || 'Disqualified by the quiz host',
      staffId,
    };
    return { success: true, player, moved: this.releaseTurn(player) };
  }

  // ─── Leaving the quiz screen (reported by the phone during a question) ──────
  // Returns { event, awayMs? } to log, or null if nothing changed.
  screenChange(socketId, hidden) {
    const player = this.playerBySocket(socketId);
    if (!player || player.status !== 'active' || this.state !== 'question') return null;
    if (hidden && !player.awaySince) {
      player.awaySince = Date.now();
      player.flags.away += 1;
      return { player, event: 'screen_left' };
    }
    if (!hidden && player.awaySince) {
      const awayMs = this.closeAway(player);
      return { player, event: 'screen_returned', awayMs };
    }
    return null;
  }

  closeAway(player) {
    if (!player.awaySince) return 0;
    const awayMs = Date.now() - player.awaySince;
    player.flags.awayMs += awayMs;
    player.awaySince = null;
    return awayMs;
  }

  // ─── Views ──────────────────────────────────────────────────────────────────
  // What a player may see about themselves.
  privateView(player) {
    return { ...publicPlayer(player), answers: player.answers, exit: player.exit && { ...player.exit, staffId: undefined } };
  }

  // What the host console and live monitor see (staff only).
  staffView(player) {
    return { ...this.privateView(player), ticketId: player.ticketId, fullName: player.fullName, flags: player.flags };
  }

  // The player's result for the current/last question, used to restore their screen on rejoin.
  // While the question is live only the chosen option is returned: right/wrong waits for the reveal.
  answerFor(player) {
    const a = this.answers[player.id];
    if (!a) return null;
    if (this.state === 'question') return { answer: a.answer, success: true };
    return { answer: a.answer, success: true, isCorrect: a.isCorrect, points: a.pointsEarned, badge: a.badge };
  }

  // Final order: players still in, then the eliminated (later exits first), then the
  // disqualified (who get no rank).
  rankedPlayers() {
    const all = Object.values(this.players);
    const active = all.filter(p => p.status === 'active').sort(byStanding);
    const eliminated = all.filter(p => p.status === 'eliminated')
      .sort((a, b) => (b.exit.round - a.exit.round) || byStanding(a, b));
    const disqualified = all.filter(p => p.status === 'disqualified').sort(byStanding);
    return [...active, ...eliminated, ...disqualified];
  }

  getPlayersList() {
    return this.rankedPlayers().map(publicPlayer);
  }

  getStaffPlayersList() {
    return this.rankedPlayers().map(p => this.staffView(p));
  }

  // Players who can still answer and are online (the "answers in" denominator).
  connectedCount() {
    return this.activePlayers().filter(p => p.connected && (!this.sd || this.sd.ids.has(p.id))).length;
  }

  // Coordinator's scoring rules (lobby only). Unknown keys are ignored; the rules are fixed once the game starts.
  setRules(input) {
    if (this.state !== 'lobby') return { error: 'Scoring can only be changed before the game starts' };
    const next = { ...this.rules };
    for (const key of Object.keys(DEFAULT_RULES)) {
      if (typeof input?.[key] === 'boolean') next[key] = input[key];
    }
    this.rules = next;
    return { success: true, rules: { ...this.rules } };
  }

  // Round reset: everyone still in starts the new round at 0 (the tie-break time restarts too).
  resetRoundScores() {
    this.activePlayers().forEach(p => { p.score = 0; p.streak = 0; p.totalResponseTime = 0; p.tieBreak = 0; });
  }

  // The level's details as shown to players: with the multiplier rule off, every level counts ×1.
  levelConfigShown() {
    const info = this.levelInfo(this.currentLevel);
    return this.rules.multiplier ? info : { ...info, multiplier: 1 };
  }

  startGame() {
    if (this.state !== 'lobby') return { error: 'Game already started' };
    if (this.questions.length === 0) return { error: 'No questions loaded' };
    this.state = 'intro';
    this.currentQuestionIndex = 0;
    this.currentLevel = this.questions[0].level || 1;
    return { success: true };
  }

  // Advances to the next question, showing a level intro first whenever the level changes.
  startQuestion() {
    this.showScoreboard = false;
    if (this.sd && this.state === 'video') return this.goSuddenDeath();
    if (!['intro', 'leaderboard', 'video'].includes(this.state)) return { error: 'Cannot start a question now' };
    if (this.pendingCut) return { error: 'Confirm the cut first — it is waiting below' };
    if (this.currentQuestionIndex >= this.questions.length || this.activePlayers().length === 0) {
      this.state = 'podium';
      return { success: true };
    }

    const q = this.currentQuestion();
    if (this.state !== 'intro' && (q.level || 1) !== this.currentLevel) {
      this.currentLevel = q.level || 1;
      this.state = 'intro';
      if (this.rules.roundReset || this.levelInfo(this.currentLevel).resetScores) this.resetRoundScores();
      return { success: true };
    }

    // A video question plays its video first: no question, no answers and no timer until it ends.
    if (q.video && this.state !== 'video') {
      this.currentLevel = q.level || 1;
      this.state = 'video';
      return { success: true };
    }

    this.currentLevel = q.level || 1;
    this.state = 'question';
    this.questionStartTime = Date.now();
    this.questionEndsAt = this.questionStartTime + (q.timeLimit || 20) * 1000;
    this.timerMax = q.timeLimit || 20;
    this.answers = {};
    this.firstBloodAwarded = false;
    const { mode, untimed } = this.levelInfo(this.currentLevel);
    this.live = null;
    if (mode === 'display') {
      if (untimed) this.clearTimer();
      return { success: true };
    }
    // The API keeps spoken questions out of standard levels; if one gets here it still needs a player.
    const turnMode = mode === 'standard' && isSpoken(q) ? 'passing' : mode;
    if (turnMode !== 'standard') return { success: true, ...this.beginTurns(turnMode, q) };
    return { success: true };
  }

  // ─── Buzzer and passing rounds ──────────────────────────────────────────────
  // One player at a time holds the question and answers on their phone. Any step that ends a
  // turn returns { finished }: true when the question is over, otherwise the next turn is running
  // and questionEndsAt is its deadline. Scores still change only at the reveal (endQuestion).
  beginTurns(mode, q) {
    const untimed = mode === 'buzzer' && this.levelInfo(this.currentLevel).untimed;
    this.live = { mode, phase: 'open', holder: null, out: new Set(), tries: 0, remainingMs: 0, turnStartedAt: null, order: [], turn: -1, untimed, presses: [] };
    if (untimed) this.clearTimer();
    if (mode === 'buzzer') return { finished: false };
    // Everyone gets the first go in turn: the starting player moves along with each question.
    const seats = this.activePlayers();
    const level = q.level || 1;
    const asked = this.questions.slice(0, this.currentQuestionIndex).filter(x => (x.level || 1) === level).length;
    const start = asked % seats.length;
    this.live.order = [...seats.slice(start), ...seats.slice(0, start)].slice(0, PASS_MAX_TURNS).map(p => p.id);
    return this.nextTurn();
  }

  // A show-only round, where the coordinator decides when each question ends.
  isManual() {
    return !this.sd && this.levelInfo(this.currentLevel).mode === 'display';
  }

  // Any round whose results the quiz master keeps by hand.
  byHand() {
    return !this.sd && this.levelInfo(this.currentLevel).manualResults;
  }

  // A buzzer round kept by hand: nobody locks, and the screens show the order everyone pressed in.
  pressOrder() {
    return this.live?.mode === 'buzzer' && this.byHand();
  }

  clearTimer() {
    this.questionEndsAt = null;
    this.timerMax = null;
  }

  // The server's timer acts unless the round has no timer, or a spoken answer waits for the
  // coordinator: running out of time mid-sentence must not score anything by itself.
  timerActs() {
    if (this.questionEndsAt == null || this.isManual()) return false;
    return !(this.live?.phase === 'answering' && isSpoken(this.currentQuestion()));
  }

  startTurn(player, seconds) {
    const now = Date.now();
    Object.assign(this.live, { phase: 'answering', holder: player.id, turnStartedAt: now });
    this.questionEndsAt = now + seconds * 1000;
    this.timerMax = seconds;
  }

  // Passing: the question goes to the next player who is still in and online.
  nextTurn() {
    const { live } = this;
    const limit = this.currentQuestion().timeLimit || 20;
    for (live.turn += 1; live.turn < live.order.length; live.turn += 1) {
      const player = this.players[live.order[live.turn]];
      if (player?.status !== 'active' || !player.connected) continue;
      this.startTurn(player, live.tries === 0 ? limit : Math.max(MIN_TURN_SECONDS, Math.round(limit * PASS_TURN_SHARE)));
      return { finished: false };
    }
    live.holder = null;
    return { finished: true };
  }

  // The holder's turn ended without a correct answer: the question moves on.
  moveOn() {
    const { live } = this;
    live.out.add(live.holder);
    if (live.mode === 'passing') {
      return this.levelInfo(this.currentLevel).afterMiss === 'close' ? { finished: true } : this.nextTurn();
    }
    // Buzzer: open again for whoever is left, with the time that was on the clock.
    Object.assign(live, { phase: 'open', holder: null });
    const anyoneLeft = this.activePlayers().some(p => !live.out.has(p.id));
    if (!anyoneLeft || (!live.untimed && live.remainingMs <= 0)) return { finished: true };
    if (live.untimed) {
      this.clearTimer();
      return { finished: false };
    }
    this.questionEndsAt = Date.now() + live.remainingMs;
    this.timerMax = this.currentQuestion().timeLimit || 20;
    return { finished: false };
  }

  // A player who left the game can't keep holding the question.
  releaseTurn(player) {
    return this.state === 'question' && this.live?.holder === player.id ? this.moveOn() : null;
  }

  turnBase() {
    const multiplier = this.rules.multiplier ? this.levelInfo(this.currentLevel).multiplier : 1;
    return (this.currentQuestion().points || 1000) * multiplier;
  }

  // Points for a turn's outcome ('correct', 'wrong' or 'timeout'). A level's fixed points replace
  // the question's own.
  turnPoints(outcome) {
    if (this.byHand()) return 0;
    const { live } = this;
    const { scoring } = this.levelInfo(this.currentLevel);
    if (scoring) return scoring[outcome] ?? 0;
    const base = this.turnBase();
    if (live.mode === 'buzzer') return Math.round(outcome === 'correct' ? base : -base * BUZZ_PENALTY);
    if (outcome !== 'correct') return 0;
    return Math.round(live.tries === 0 ? base : base * PASS_POINTS_SHARE);
  }

  turnBadge() {
    if (this.live.mode === 'buzzer') return 'Buzzer Beater';
    return this.live.tries === 0 ? 'Direct Hit' : 'Stolen!';
  }

  recordTurn(player, answer, isCorrect, pointsEarned, badge) {
    const time = Date.now() - this.live.turnStartedAt;
    player.totalResponseTime += time;
    this.live.tries += 1;
    const record = { participantId: player.id, answer, time, isCorrect, pointsEarned, badge, flagged: false };
    this.answers[player.id] = record;
    return record;
  }

  buzz(socketId) {
    return this.buzzAs(this.playerBySocket(socketId));
  }

  // A physical buzzer, pressed for a player at the host console.
  buzzFor(participantId) {
    return this.buzzAs(this.players[participantId]);
  }

  buzzAs(player) {
    if (!player) return { error: 'You are not in this game' };
    if (player.status !== 'active') return { error: "You're out of the game — you can keep watching" };
    if (this.sd && !this.sd.ids.has(player.id)) return { error: 'This sudden death is between other players' };
    const { live } = this;
    if (this.state !== 'question' || live?.mode !== 'buzzer') return { error: 'The buzzer is not open' };
    if (this.pressOrder()) return this.press(player);
    if (live.out.has(player.id)) return { error: 'You already had your turn on this question' };
    if (live.phase !== 'open') return { error: 'Someone else buzzed first' };
    const now = Date.now();
    if (!live.untimed && now > this.questionEndsAt + ANSWER_GRACE_MS) return { error: "Time's up" };
    live.remainingMs = live.untimed ? 0 : Math.max(0, this.questionEndsAt - now);
    this.startTurn(player, this.levelInfo(this.currentLevel).answerSeconds);
    return { success: true, player };
  }

  // Each player presses once, and the server's arrival order is the order on the screens.
  press(player) {
    const { live } = this;
    if (live.presses.includes(player.id)) return { error: 'Already buzzed' };
    if (!live.untimed && Date.now() > this.questionEndsAt + ANSWER_GRACE_MS) return { error: "Time's up" };
    live.presses.push(player.id);
    return { success: true, player, position: live.presses.length };
  }

  passTurn(socketId) {
    const player = this.playerBySocket(socketId);
    if (!player) return { error: 'You are not in this game' };
    if (this.state !== 'question' || this.live?.mode !== 'passing') return { error: 'You can only pass in a passing round' };
    if (this.live.holder !== player.id) return { error: "It's not your turn" };
    this.recordTurn(player, '', false, 0, null);
    return { success: true, player, ...this.moveOn() };
  }

  submitTurnAnswer(player, answer) {
    const { live } = this;
    if (live.holder !== player.id) return { error: live.mode === 'buzzer' ? 'Only the player who buzzed can answer' : "It's not your turn" };
    const q = this.currentQuestion();
    if (isSpoken(q)) return { error: 'Say your answer out loud' };
    if (typeof answer !== 'string' || !answer) return { error: 'Invalid answer' };
    if (q.options?.length && !q.options.includes(answer)) return { error: 'Invalid option' };
    if (Date.now() > this.questionEndsAt + ANSWER_GRACE_MS) return { error: "Time's up" };

    const isCorrect = answer.toLowerCase() === String(q.correctAnswer).toLowerCase();
    const points = this.turnPoints(isCorrect ? 'correct' : 'wrong');
    const record = this.recordTurn(player, answer, isCorrect, points, isCorrect ? this.turnBadge() : null);
    const { finished } = isCorrect ? { finished: true } : this.moveOn();
    return { success: true, record, player, turnBased: true, finished };
  }

  // The coordinator marks a spoken answer: correct, wrong, pass, or timeout (no answer given).
  judge(verdict) {
    const { live } = this;
    if (this.state !== 'question' || !live || live.phase !== 'answering') return { error: 'Nobody is answering right now' };
    if (!isSpoken(this.currentQuestion())) return { error: 'This question is scored automatically' };
    if (!['correct', 'wrong', 'pass', 'timeout'].includes(verdict)) return { error: 'Unknown verdict' };
    if (verdict === 'pass' && live.mode !== 'passing') return { error: 'There is no passing in a buzzer round' };
    const player = this.players[live.holder];
    if (!player) return { error: 'Player not found' };
    if (verdict === 'correct') {
      const record = this.recordTurn(player, 'spoken', true, this.turnPoints('correct'), this.turnBadge());
      return { success: true, player, record, finished: true };
    }
    // A pass and no answer leave the answer blank; a wrong answer was given.
    const record = verdict === 'pass'
      ? this.recordTurn(player, '', false, 0, null)
      : this.recordTurn(player, verdict === 'wrong' ? 'spoken' : '', false, this.turnPoints(verdict), null);
    return { success: true, player, record, ...this.moveOn() };
  }

  // ─── Sudden death ───────────────────────────────────────────────────────────
  // A tie-break between chosen players on a spare question, from the reveal screen. It decides
  // their order and changes no score. With options: fastest correct answer wins. Spoken: buzzers,
  // first correct answer wins, and a wrong answer hands the question to the others.
  startSuddenDeath(ids, questionId) {
    if (this.state !== 'leaderboard') return { error: 'Sudden death starts from the reveal screen' };
    const players = [...new Set(Array.isArray(ids) ? ids : [])].map(id => this.players[id]).filter(p => p?.status === 'active');
    if (players.length < 2) return { error: 'Pick at least two players who are still in' };
    const question = this.backups.find(q => q.id === questionId && !this.backupsUsed.has(q.id));
    if (!question) return { error: 'That spare question is not available' };
    this.backupsUsed.add(question.id);
    this.sd = { question, ids: new Set(players.map(p => p.id)), resume: this.lastResult };
    this.showScoreboard = false;
    if (question.video) {
      this.state = 'video';
      return { success: true };
    }
    return this.goSuddenDeath();
  }

  goSuddenDeath() {
    const q = this.sd.question;
    this.state = 'question';
    this.questionStartTime = Date.now();
    this.questionEndsAt = this.questionStartTime + (q.timeLimit || 20) * 1000;
    this.timerMax = q.timeLimit || 20;
    this.answers = {};
    this.firstBloodAwarded = false;
    this.live = null;
    if (isSpoken(q)) {
      this.beginTurns('buzzer', q);
      this.live.untimed = true;
      this.clearTimer();
      for (const p of this.activePlayers()) if (!this.sd.ids.has(p.id)) this.live.out.add(p.id);
    }
    return { success: true };
  }

  endSuddenDeath(cancelled) {
    const { question: q, ids, resume } = this.sd;
    const tied = [...ids].map(id => this.players[id]).filter(Boolean);
    const winnerId = cancelled ? null : Object.values(this.answers)
      .filter(a => a.isCorrect && ids.has(a.participantId))
      .sort((a, b) => a.time - b.time)[0]?.participantId;
    const winner = winnerId ? this.players[winnerId] : null;
    const answers = cancelled ? [] : Object.values(this.answers);
    const stats = {};
    (q.options || []).forEach(o => { stats[o] = 0; });
    for (const a of answers) {
      if (a.answer && !isSpoken(q)) stats[a.answer] = (stats[a.answer] || 0) + 1;
      a.pointsEarned = 0; // decides the order only
    }
    if (cancelled) this.answers = {};
    for (const p of tied) {
      this.closeAway(p);
      p.totalResponseTime -= this.answers[p.id]?.time ?? 0; // the tie-break's time doesn't count either
    }
    if (winner) winner.tieBreak += 1;

    // The winner moves above the others at the cut line.
    let { pendingCut, atRisk } = resume ?? {};
    if (this.pendingCut) {
      const fresh = this.computeCut(this.pendingCut.level, 'speed');
      this.pendingCut.keep = fresh.keep;
      this.pendingCut.out = new Set(fresh.out);
      pendingCut = { label: fresh.info.cut.label, advancing: fresh.keep.size, out: fresh.out.length };
      atRisk = fresh.out;
    }
    this.sd = null;
    this.live = null;
    this.state = 'leaderboard';
    this.lastResult = {
      ...resume,
      state: this.state,
      mode: 'sudden',
      turns: [],
      correctAnswer: cancelled ? null : q.correctAnswer,
      note: cancelled ? null : q.note || null,
      stats: cancelled ? {} : stats,
      cancelled,
      backupAllowed: false,
      speedStar: null,
      hasImage: false,
      pendingCut,
      atRisk,
      leaderboard: this.activePlayers().sort(byStanding).map(publicPlayer),
      suddenDeath: { winner: winner?.name ?? null, players: tied.map(p => p.name) },
    };
    return this.lastResult;
  }

  // The rounds behind the current total: from the last level that started at 0, up to now.
  scoreColumns() {
    const levels = this.levelNumbers();
    const current = Math.max(0, levels.indexOf(this.currentLevel));
    let from = 0;
    levels.forEach((n, i) => { if (i <= current && this.levelInfo(n).resetScores) from = i; });
    return levels.slice(from, current + 1).map(n => this.levelInfo(n).name);
  }

  // For the coordinator only, who has to judge what is said out loud.
  hostAnswer() {
    const q = this.state === 'question' ? this.currentQuestion() : null;
    return q && (isSpoken(q) || this.byHand()) ? { answer: q.correctAnswer, accepted: q.accepted || '' } : null;
  }

  // The timer ran out. Who holds the question misses their turn; with the buzzers open and nobody
  // holding it, the question is over.
  expireTurn() {
    const { live } = this;
    if (this.state !== 'question' || !live || live.phase !== 'answering') return { finished: true };
    const player = this.players[live.holder];
    if (player) this.recordTurn(player, '', false, this.turnPoints('timeout'), null);
    return this.moveOn();
  }

  liveView() {
    const { live } = this;
    if (!live || this.state !== 'question') return null;
    const holder = this.players[live.holder];
    return {
      mode: live.mode,
      phase: live.phase,
      holder: holder ? { id: holder.id, name: holder.name, avatar: holder.avatar } : null,
      out: [...live.out],
      tries: live.tries,
      afterMiss: this.levelInfo(this.currentLevel).afterMiss,
      presses: this.pressOrder()
        ? live.presses.map(id => this.players[id]).filter(p => p?.status === 'active').map(p => ({ id: p.id, name: p.name, avatar: p.avatar }))
        : null,
    };
  }

  // Returns { success, answer } — the recorded answer is for the server-side log only; the phone
  // gets just { success: true }.
  submitAnswer(socketId, answer) {
    const player = this.playerBySocket(socketId);
    if (!player) return { error: 'You are not in this game' };
    if (player.status !== 'active') return { error: player.status === 'disqualified' ? 'You have been disqualified' : "You're out of the game — you can keep watching" };
    if (this.state !== 'question') return { error: 'Not accepting answers now' };
    if (this.sd && !this.sd.ids.has(player.id)) return { error: 'This sudden death is between other players' };
    if (this.isManual()) return { error: 'This round is answered out loud' };
    if (this.answers[player.id]) return { error: 'Already answered' };
    if (this.live) return this.submitTurnAnswer(player, answer);

    const q = this.currentQuestion();
    if (typeof answer !== 'string' || !answer) return { error: 'Invalid answer' };
    if (q.options?.length && !q.options.includes(answer)) return { error: 'Invalid option' };

    const now = Date.now();
    if (now > this.questionEndsAt + ANSWER_GRACE_MS) return { error: "Time's up" };

    const timeTaken = now - this.questionStartTime;
    const isCorrect = answer.toLowerCase() === String(q.correctAnswer).toLowerCase();

    let points = 0;
    let badge = null;
    let flagged = false;

    if (isCorrect) {
      const timeLimitMs = (q.timeLimit || 20) * 1000;
      const timeRemaining = Math.max(0, timeLimitMs - timeTaken);
      const multiplier = this.rules.multiplier ? this.levelInfo(this.currentLevel).multiplier : 1;

      // Base points + time bonus
      const baseScore = (q.points || 1000) * multiplier;
      points = Math.round(baseScore * (0.5 + 0.5 * (timeRemaining / timeLimitMs)));

      if (this.rules.firstBlood && !this.firstBloodAwarded) {
        points += Math.round(baseScore * 0.20);
        this.firstBloodAwarded = true;
        badge = '1st to Answer';
      }

      // Score and streak are applied in endQuestion, so nothing the player can see changes before the reveal.
      if (this.rules.streak && player.streak + 1 >= 3) {
        points += Math.round(baseScore * 0.10);
        if (!badge) badge = 'Streak Master';
      }
      if (timeTaken < 2000 && !badge) badge = 'Lightning';
      if (timeTaken < FAST_CORRECT_MS && (q.timeLimit || 20) >= 10) {
        player.flags.fastCorrect += 1;
        flagged = true;
      }
    }
    player.totalResponseTime += timeTaken;

    const record = { participantId: player.id, answer, time: timeTaken, isCorrect, pointsEarned: points, badge, flagged };
    this.answers[player.id] = record;
    return { success: true, record, player };
  }

  answeredCount() {
    return Object.keys(this.answers).length;
  }

  // Returns null if no question is live (guards against the auto-timer and host both ending it).
  // A cancelled question goes through the same reveal, so a cut or the end of the round still
  // happens, but nothing about it counts: no points, no skip, no answer time, no streak change.
  endQuestion({ cancelled = false } = {}) {
    if (this.state !== 'question' && !(cancelled && this.state === 'video')) return null;
    if (this.sd) return this.endSuddenDeath(cancelled);
    const manual = this.byHand();
    this.state = 'leaderboard';

    if (cancelled) {
      for (const a of Object.values(this.answers)) {
        const p = this.players[a.participantId];
        if (!p) continue;
        p.totalResponseTime -= a.time;
        if (a.flagged) p.flags.fastCorrect -= 1;
      }
      this.answers = {};
    }

    const q = this.currentQuestion();
    const level = q.level || 1;
    const stats = {};
    (q.options || []).forEach(o => { stats[o] = 0; });

    let speedStar = null;
    let minTime = Infinity;
    for (const a of Object.values(this.answers)) {
      if (a.answer && !isSpoken(q)) stats[a.answer] = (stats[a.answer] || 0) + 1; // a pass has no answer
      if (a.isCorrect && a.time < minTime) {
        minTime = a.time;
        speedStar = this.players[a.participantId]?.name || null;
      }
    }

    // Standings before this question, so the projector can show the old order first and animate.
    const before = new Map(this.activePlayers().sort(byStanding).map((p, i) => [p.id, { rank: i + 1, score: p.score }]));

    // Apply the scores at the reveal. A wrong answer or no answer breaks the streak, and no
    // answer counts as the full timer for tie-breaks. In a buzzer or passing round only the players
    // who held the question are affected.
    const turnMode = this.live?.mode ?? null;
    for (const p of this.activePlayers()) {
      this.closeAway(p);
      if (cancelled || manual) continue;
      const a = this.answers[p.id];
      if (!a && turnMode) continue;
      if (!a) p.totalResponseTime += (q.timeLimit || 20) * 1000;
      p.lastResponseTime = a ? a.time : (q.timeLimit || 20) * 1000;
      p.answers[!a?.answer ? 'skipped' : a.isCorrect ? 'correct' : 'wrong'] += 1;
      p.score += a?.pointsEarned ?? 0; // penalties are negative
      const roundName = this.levelInfo(level).name;
      p.roundPoints[roundName] = (p.roundPoints[roundName] || 0) + (a?.pointsEarned ?? 0);
      if (a?.isCorrect) {
        p.streak += 1;
        p.levelCorrect[level] = (p.levelCorrect[level] || 0) + 1;
      } else {
        p.streak = 0;
      }
    }

    this.currentQuestionIndex++;
    const next = this.questions[this.currentQuestionIndex];
    const levelEnds = !next || (next.level || 1) !== level;
    // Who is below the line right now (shown as "at risk" during the level). At the level's end
    // the cut waits for the coordinator to review and confirm it.
    const proposal = manual ? null : this.computeCut(level);
    let pendingCut = null;
    let elimination = null;
    if (levelEnds && proposal) {
      if (proposal.out.length) {
        this.pendingCut = { level, info: proposal.info, keep: proposal.keep, out: new Set(proposal.out) };
        pendingCut = { label: proposal.info.cut.label, advancing: proposal.keep.size, out: proposal.out.length };
      } else {
        elimination = { level, round: proposal.info.round, levelName: proposal.info.name, label: proposal.info.cut.label, advanced: proposal.keep.size, eliminated: [] };
      }
    }
    // Told to every phone at the reveal, so players know the round is over (and whether a cut follows).
    const endedLevel = this.levelInfo(level);
    const roundEnd = levelEnds ? {
      round: endedLevel.round, levelName: endedLevel.name, isFinal: !next, cutPending: !!pendingCut,
      cutLabel: endedLevel.cut?.label ?? null, eliminated: 0,
    } : null;

    // Who held the question, in order, for the projector.
    const turns = turnMode ? Object.values(this.answers).map(a => ({
      name: this.players[a.participantId]?.name ?? '',
      outcome: a.isCorrect ? 'correct' : a.answer ? 'wrong' : 'missed',
      points: a.pointsEarned,
    })) : [];
    this.live = null;

    this.lastResult = {
      state: this.state,
      mode: turnMode ?? this.levelInfo(level).mode,
      byHand: manual,
      turns,
      correctAnswer: cancelled ? null : q.correctAnswer,
      note: cancelled ? null : q.note || null,
      stats: cancelled ? {} : stats,
      cancelled,
      backupAllowed: cancelled,
      speedStar,
      // Everyone still in, in order (the projector adapts its layout to the count), with their
      // previous rank and score for the animation.
      leaderboard: this.activePlayers().sort(byStanding).map(p => ({
        ...publicPlayer(p), prevRank: before.get(p.id)?.rank ?? null, prevScore: before.get(p.id)?.score ?? p.score,
      })),
      atRisk: proposal ? proposal.out : [],
      cutLabel: proposal ? proposal.info.cut.label : null,
      pendingCut,
      elimination,
      roundEnd,
      hasImage: !!q.image,
      questionIndex: this.currentQuestionIndex - 1,
      isLastQuestion: !next || this.activePlayers().length === 0,
    };
    return this.lastResult;
  }

  // A player's place among those still in (for their phone at each reveal).
  standingOf(player) {
    if (player.status !== 'active') return null;
    const ranked = this.activePlayers().sort(byStanding);
    return {
      rank: ranked.indexOf(player) + 1,
      of: ranked.length,
      atRisk: !!this.lastResult?.atRisk?.includes(player.id),
      cutLabel: this.lastResult?.cutLabel ?? null,
    };
  }

  // A question's picture, only once that question is live (or already revealed).
  liveImage(index) {
    if (index === -1) return this.state === 'question' ? this.sd?.question.image ?? null : null; // sudden death
    const q = this.questions[index];
    if (!q?.image) return null;
    const shown = index < this.currentQuestionIndex || (this.state === 'question' && index === this.currentQuestionIndex);
    return shown ? q.image : null;
  }

  getState() {
    const q = this.state === 'question' ? this.currentQuestion() : null;
    return {
      state: this.state,
      currentQuestionIndex: this.currentQuestionIndex,
      currentLevel: this.levelInfo(this.currentLevel).round, // round number shown to people
      totalLevels: this.levelNumbers().length,
      totalQuestions: this.questions.length,
      levelConfig: this.levelConfigShown(),
      rules: { ...this.rules },
      live: this.liveView(),
      manual: this.state === 'question' && this.isManual(),
      byHand: this.state === 'question' && this.byHand(),
      revealByHand: this.state === 'leaderboard' && !!this.lastResult?.byHand,
      // The final's results were kept by hand: the game has no winners to show.
      manualFinish: this.levelInfo(this.levelNumbers().at(-1)).manualResults,
      suddenDeath: this.sd ? { players: [...this.sd.ids].map(id => ({ id, name: this.players[id]?.name ?? '', avatar: this.players[id]?.avatar })) } : null,
      suddenDeathResult: this.state === 'leaderboard' ? this.lastResult?.suddenDeath ?? null : null,
      showScoreboard: this.showScoreboard,
      scoreColumns: this.scoreColumns(),
      timerMax: this.state === 'question' ? this.timerMax : null,
      revealMode: this.state === 'leaderboard' ? this.lastResult?.mode ?? 'standard' : null,
      playersLeft: this.activePlayers().length,
      cutPending: !!this.pendingCut,
      hideFinalStandings: this.hideFinalStandings,
      standingsHidden: this.hideFinalStandings && this.state !== 'lobby' && this.state !== 'podium'
        && this.levelNumbers().at(-1) === this.currentLevel,
      questionStartTime: this.questionStartTime,
      questionEndsAt: this.questionEndsAt,
      serverNow: Date.now(),
      // The video of the next question, only while it is playing (the projector shows it).
      video: this.state === 'video' ? this.currentQuestion()?.video ?? null : null,
      // The note explains the answer, so like the answer it is sent only at the reveal.
      answerNote: this.state === 'leaderboard' ? this.lastResult?.note ?? null : null,
      cancelled: this.state === 'leaderboard' && !!this.lastResult?.cancelled,
      canUseBackup: this.state === 'leaderboard' && !!this.lastResult?.backupAllowed && this.backupList().some(b => !b.used),
      // Never send the correct answer while a question is live.
      currentQuestion: q ? {
        id: q.id,
        level: q.level,
        text: q.text,
        type: q.type,
        spoken: isSpoken(q),
        options: q.options,
        timeLimit: q.timeLimit,
        hasImage: !!q.image,
        // Where the picture is served from (the game server), only while this question is live.
        imageUrl: q.image ? `/live-image/${this.sd ? -1 : this.currentQuestionIndex}?g=${this.gameId}${this.sd ? `&q=${q.id}` : ''}` : null,
      } : null,
      finalLeaderboard: this.state === 'podium' ? this.getPlayersList() : null,
    };
  }
}

module.exports = new GameEngine();
module.exports.ANSWER_GRACE_MS = ANSWER_GRACE_MS;
module.exports.DEFAULT_RULES = DEFAULT_RULES;
