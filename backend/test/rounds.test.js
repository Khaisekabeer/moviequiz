// Spec tests for buzzer and passing rounds. No database or network, like spec.test.js.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require.cache[path.join(__dirname, '..', 'store.js')] = {
  id: 'store', filename: 'store', loaded: true, exports: {},
};

const engine = require('../gameEngine');

const q = (id, mode, extra = {}) => ({
  id, level: 1, text: `Question ${id}`, type: 'mcq', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A',
  timeLimit: 20, points: 1000, levelName: 'Round', multiplier: 1, cut: null, theme: null, mode,
  image: null, video: null, ...extra,
});

const players = (n) => {
  for (let i = 0; i < n; i++) engine.addPlayer(`s${i + 1}`, `Player ${i + 1}`, '', null, null);
};
const byName = (n) => Object.values(engine.players).find(p => p.name === `Player ${n}`);

const start = (questions, n) => {
  engine.setQuestions(questions);
  players(n);
  engine.startGame();
  return engine.startQuestion(); // intro -> question
};

beforeEach(() => {
  engine.reset();
  engine.rules = { ...engine.DEFAULT_RULES };
});

describe('standard rounds are unchanged', () => {
  test('a level without a mode is standard and anyone can answer at once', () => {
    start([q(1, undefined)], 2);
    assert.equal(engine.levelInfo(1).mode, 'standard');
    assert.equal(engine.getState().live, null);
    assert.equal(engine.submitAnswer('s1', 'A').success, true);
    assert.equal(engine.submitAnswer('s2', 'B').success, true);
  });

  test('passing is refused and buzzing is refused outside their rounds', () => {
    start([q(1, 'standard')], 1);
    assert.ok(engine.buzz('s1').error);
    assert.ok(engine.passTurn('s1').error);
  });
});

describe('buzzer round', () => {
  test('nobody can answer before buzzing', () => {
    start([q(1, 'buzzer')], 2);
    assert.match(engine.submitAnswer('s1', 'A').error, /buzzed/);
  });

  test('all players can buzz and the order is kept; first buzz answers', () => {
    start([q(1, 'buzzer')], 2);
    assert.equal(engine.buzz('s1').position, 1);
    assert.equal(engine.buzz('s2').position, 2);
    const live = engine.getState().live;
    assert.equal(live.phase, 'answering');
    assert.equal(live.holder.name, 'Player 1');
    assert.deepEqual(live.presses.map(p => p.name), ['Player 1', 'Player 2']);
    assert.equal(engine.getState().timerMax, 10);
  });

  test('only the holder can answer, and a correct answer ends the question with full points', () => {
    start([q(1, 'buzzer')], 2);
    engine.buzz('s1');
    assert.match(engine.submitAnswer('s2', 'A').error, /who buzzed/);
    const r = engine.submitAnswer('s1', 'A');
    assert.equal(r.finished, true);
    assert.equal(r.record.pointsEarned, 1000);
    engine.endQuestion();
    assert.equal(byName(1).score, 1000);
    assert.equal(engine.lastResult.mode, 'buzzer');
    assert.deepEqual(engine.lastResult.turns, [{ name: 'Player 1', outcome: 'correct', points: 1000 }]);
  });

  test('a wrong answer costs half the points, locks the player out and reopens the buzzers', () => {
    start([q(1, 'buzzer')], 2);
    engine.buzz('s1');
    const r = engine.submitAnswer('s1', 'B');
    assert.equal(r.finished, false);
    assert.equal(engine.getState().live.phase, 'open');
    assert.match(engine.buzz('s1').error, /already/);
    assert.equal(engine.buzz('s2').success, true);
    engine.submitAnswer('s2', 'A');
    engine.endQuestion();
    assert.equal(byName(1).score, -500);
    assert.equal(byName(2).score, 1000);
  });

  test('the scores stay hidden until the reveal', () => {
    start([q(1, 'buzzer')], 2);
    engine.buzz('s1');
    engine.submitAnswer('s1', 'B');
    assert.equal(byName(1).score, 0);
  });

  test('the clock stops while a player answers and resumes with the time that was left', () => {
    start([q(1, 'buzzer')], 2);
    engine.questionEndsAt = Date.now() + 6000; // 6 s left on the question
    engine.buzz('s1');
    engine.submitAnswer('s1', 'B');
    const left = engine.questionEndsAt - Date.now();
    assert.ok(left > 5500 && left <= 6000, `expected about 6000 ms, got ${left}`);
  });

  test('a player who buzzes and runs out of time is treated like a wrong answer', () => {
    start([q(1, 'buzzer')], 2);
    engine.buzz('s1');
    assert.equal(engine.expireTurn().finished, false);
    assert.equal(engine.getState().live.phase, 'open');
    assert.deepEqual(engine.getState().live.out, [byName(1).id]);
    engine.buzz('s2');
    engine.submitAnswer('s2', 'A');
    engine.endQuestion();
    assert.equal(byName(1).score, -500);
  });

  test('the question ends when everyone is locked out', () => {
    start([q(1, 'buzzer')], 2);
    engine.buzz('s1');
    assert.equal(engine.submitAnswer('s1', 'B').finished, false);
    engine.buzz('s2');
    assert.equal(engine.submitAnswer('s2', 'C').finished, true);
  });

  test('the question ends when the buzzers run out of time with no one holding it', () => {
    start([q(1, 'buzzer')], 2);
    assert.equal(engine.expireTurn().finished, true);
    engine.endQuestion();
    assert.equal(byName(1).score, 0);
    assert.equal(byName(1).answers.skipped, 0); // not their turn: nothing changes for them
  });

  test('players who never buzzed keep their streak and tie-break time', () => {
    start([q(1, 'buzzer')], 2);
    byName(2).streak = 2;
    engine.buzz('s1');
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    assert.equal(byName(2).streak, 2);
    assert.equal(byName(2).totalResponseTime, 0);
  });

  test('disqualifying the holder reopens the buzzers', () => {
    start([q(1, 'buzzer')], 2);
    engine.buzz('s1');
    const r = engine.disqualify(byName(1).id, 'test');
    assert.equal(r.moved.finished, false);
    assert.equal(engine.getState().live.phase, 'open');
    assert.equal(engine.buzz('s2').success, true);
  });

  test('a cancelled question changes nothing, even a penalty', () => {
    start([q(1, 'buzzer')], 2);
    engine.buzz('s1');
    engine.submitAnswer('s1', 'B');
    engine.endQuestion({ cancelled: true });
    assert.equal(byName(1).score, 0);
    assert.equal(byName(1).totalResponseTime, 0);
    assert.equal(engine.live, null);
  });

  test('the multiplier applies to points and penalties', () => {
    start([q(1, 'buzzer', { multiplier: 2 })], 2);
    engine.buzz('s1');
    assert.equal(engine.submitAnswer('s1', 'B').record.pointsEarned, -1000);
    engine.buzz('s2');
    assert.equal(engine.submitAnswer('s2', 'A').record.pointsEarned, 2000);
  });
});

describe('passing round', () => {
  test('the first player has the question with the full timer; others must wait', () => {
    start([q(1, 'passing')], 3);
    const live = engine.getState().live;
    assert.equal(live.holder.name, 'Player 1');
    assert.equal(engine.getState().timerMax, 20);
    assert.match(engine.submitAnswer('s2', 'A').error, /not your turn/);
    assert.match(engine.passTurn('s2').error, /not your turn/);
  });

  test('a direct correct answer earns full points and ends the question', () => {
    start([q(1, 'passing')], 3);
    const r = engine.submitAnswer('s1', 'A');
    assert.equal(r.finished, true);
    assert.equal(r.record.pointsEarned, 1000);
    assert.equal(r.record.badge, 'Direct Hit');
  });

  test('a pass costs nothing and hands over with half the timer and half the points', () => {
    start([q(1, 'passing')], 3);
    assert.equal(engine.passTurn('s1').finished, false);
    assert.equal(engine.getState().live.holder.name, 'Player 2');
    assert.equal(engine.getState().timerMax, 10);
    const r = engine.submitAnswer('s2', 'A');
    assert.equal(r.record.pointsEarned, 500);
    assert.equal(r.record.badge, 'Stolen!');
    engine.endQuestion();
    assert.equal(byName(1).score, 0);
    assert.equal(byName(1).answers.skipped, 1);
    assert.equal(byName(2).score, 500);
  });

  test('a wrong answer passes it on with no penalty', () => {
    start([q(1, 'passing')], 2);
    assert.equal(engine.submitAnswer('s1', 'B').finished, false);
    assert.equal(engine.submitAnswer('s2', 'B').finished, true);
    engine.endQuestion();
    assert.equal(byName(1).score, 0);
    assert.equal(byName(1).answers.wrong, 1);
  });

  test('running out of time passes it on', () => {
    start([q(1, 'passing')], 2);
    assert.equal(engine.expireTurn().finished, false);
    assert.equal(engine.getState().live.holder.name, 'Player 2');
    assert.equal(engine.expireTurn().finished, true);
  });

  test('a short timer never gives a pass less than 5 seconds', () => {
    start([q(1, 'passing', { timeLimit: 6 })], 2);
    engine.passTurn('s1');
    assert.equal(engine.getState().timerMax, 5);
  });

  test('the first go moves along with each question', () => {
    start([q(1, 'passing'), q(2, 'passing'), q(3, 'passing')], 3);
    assert.equal(engine.getState().live.holder.name, 'Player 1');
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    engine.startQuestion();
    assert.equal(engine.getState().live.holder.name, 'Player 2');
    engine.submitAnswer('s2', 'A');
    engine.endQuestion();
    engine.startQuestion();
    assert.equal(engine.getState().live.holder.name, 'Player 3');
  });

  test('a question reaches at most 6 players in a big field', () => {
    start([q(1, 'passing')], 10);
    let turns = 0;
    let done = false;
    while (!done) {
      turns += 1;
      done = engine.expireTurn().finished;
    }
    assert.equal(turns, 6);
  });

  test('a player who is offline is skipped, and the next one still gets the full first turn', () => {
    engine.setQuestions([q(1, 'passing')]);
    players(2);
    byName(1).connected = false;
    engine.startGame();
    engine.startQuestion();
    assert.equal(engine.getState().live.holder.name, 'Player 2');
    assert.equal(engine.getState().timerMax, 20);
    assert.equal(engine.submitAnswer('s2', 'A').record.pointsEarned, 1000);
  });

  test('with nobody online the question goes straight to the reveal', () => {
    engine.setQuestions([q(1, 'passing')]);
    players(1);
    byName(1).connected = false;
    engine.startGame();
    assert.equal(engine.startQuestion().finished, true);
  });

  test('disqualifying the holder hands the question on', () => {
    start([q(1, 'passing')], 2);
    const r = engine.disqualify(byName(1).id, 'test');
    assert.equal(r.moved.finished, false);
    assert.equal(engine.getState().live.holder.name, 'Player 2');
  });

  test('passed questions leave no blank entry in the reveal stats', () => {
    start([q(1, 'passing')], 2);
    engine.passTurn('s1');
    engine.submitAnswer('s2', 'A');
    const result = engine.endQuestion();
    assert.deepEqual(result.stats, { A: 1, B: 0, C: 0, D: 0 });
    assert.deepEqual(result.turns.map(t => t.outcome), ['missed', 'correct']);
  });

  test('a backup keeps the round type of the question it replaces', () => {
    start([q(1, 'passing'), q(2, 'passing', { backup: true })], 2);
    engine.endQuestion({ cancelled: true });
    engine.useBackup(2);
    assert.equal(engine.getState().live.mode, 'passing');
  });

  for (const mode of ['passing', 'buzzer']) {
    test(`a spare with options loses them when it replaces a ${mode} question`, () => {
      start([q(1, mode), q(2, 'standard', { backup: true })], 2);
      engine.endQuestion({ cancelled: true });
      engine.useBackup(2);
      const shown = engine.getState().currentQuestion;
      assert.deepEqual(shown.options, []);
      assert.equal(shown.spoken, true);
      assert.equal(engine.hostAnswer().answer, 'A');
    });
  }

  test('a spare keeps its options in a standard round', () => {
    start([q(1, 'standard'), q(2, 'standard', { backup: true })], 2);
    engine.endQuestion({ cancelled: true });
    engine.useBackup(2);
    assert.equal(engine.getState().currentQuestion.options.length, 4);
  });
});

describe('spoken questions (no options, the coordinator marks the answer)', () => {
  const round3 = (id, extra = {}) => q(id, 'passing', { type: 'short', options: [], correctAnswer: 'Drishyam', accepted: 'Papanasam', afterMiss: 'close', scoring: { correct: 10, wrong: -5, timeout: -5 }, ...extra });
  const round4 = (id, extra = {}) => q(id, 'buzzer', { type: 'short', options: [], correctAnswer: 'Drishyam', scoring: { correct: 10, wrong: -5, timeout: 0 }, untimed: true, answerSeconds: 3, ...extra });

  test('a player cannot answer one on the phone', () => {
    start([round3(1)], 2);
    assert.match(engine.submitAnswer('s1', 'Drishyam').error, /out loud/);
  });

  test('only the coordinator sees the answer while it is live; the state never carries it', () => {
    start([round3(1)], 2);
    assert.deepEqual(engine.hostAnswer(), { answer: 'Drishyam', accepted: 'Papanasam' });
    assert.ok(!JSON.stringify(engine.getState()).includes('Drishyam'));
    assert.ok(!JSON.stringify(engine.getState()).includes('Papanasam'));
  });

  test('multiple-choice questions give the host no answer', () => {
    start([q(1, 'passing')], 2);
    assert.equal(engine.hostAnswer(), null);
  });

  test('round 3 scoring: correct +10, pass 0, wrong -5, no answer -5, one player per question', () => {
    const cases = [['correct', 10], ['pass', 0], ['wrong', -5], ['timeout', -5]];
    for (const [verdict, points] of cases) {
      engine.reset();
      start([round3(1)], 3);
      assert.equal(engine.judge(verdict).finished, true, verdict);
      engine.endQuestion();
      assert.equal(byName(1).score, points, verdict);
      assert.equal(byName(2).score, 0, verdict);
    }
  });

  test('with "next player" set, a pass still hands the question on', () => {
    start([round3(1, { afterMiss: 'next' })], 2);
    assert.equal(engine.judge('pass').finished, false);
    assert.equal(engine.getState().live.holder.name, 'Player 2');
  });

  test('five finalists get three questions each, one at a time', () => {
    start(Array.from({ length: 15 }, (_, i) => round3(i + 1)), 5);
    const turns = [];
    for (let i = 0; i < 15; i++) {
      turns.push(engine.getState().live.holder.name);
      engine.judge('correct');
      engine.endQuestion();
      engine.startQuestion();
    }
    assert.deepEqual(turns.slice(0, 6), ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 1']);
    for (let n = 1; n <= 5; n++) assert.equal(byName(n).score, 30);
  });

  test('the timer never marks a spoken answer: running out waits for the coordinator', () => {
    start([round3(1)], 2);
    assert.equal(engine.timerActs(), false);
    assert.equal(engine.state, 'question');
  });

  test('round 4: everyone can press, first to press answers, order is kept', () => {
    start([round4(1)], 3);
    assert.equal(engine.questionEndsAt, null, 'no fixed time limit');
    assert.equal(engine.buzz('s1').position, 1);
    assert.equal(engine.buzz('s2').position, 2);
    assert.equal(engine.getState().live.holder.name, 'Player 1');
    assert.equal(engine.getState().timerMax, 3);
    assert.equal(engine.judge('correct').finished, true);
    engine.endQuestion();
    assert.equal(byName(1).score, 10);
  });

  test('round 4 rebound: a wrong answer reopens, still with no timer, one attempt each', () => {
    start([round4(1)], 2);
    engine.buzz('s1');
    assert.equal(engine.judge('wrong').finished, false);
    assert.equal(engine.getState().live.phase, 'open');
    assert.equal(engine.questionEndsAt, null);
    assert.match(engine.buzz('s1').error, /already/);
    engine.buzz('s2');
    assert.equal(engine.judge('correct').finished, true);
    engine.endQuestion();
    assert.equal(byName(1).score, -5);
    assert.equal(byName(2).score, 10);
  });

  test('round 4: everyone wrong ends it, and nobody buzzing scores nothing', () => {
    start([round4(1), round4(2)], 2);
    engine.buzz('s1');
    engine.judge('wrong');
    engine.buzz('s2');
    assert.equal(engine.judge('wrong').finished, true);
    engine.endQuestion();
    engine.startQuestion();
    assert.equal(engine.timerActs(), false, 'waits for the coordinator to close it');
    engine.endQuestion();
    assert.equal(byName(1).score, -5);
  });

  test('a judgement needs someone answering, and no passing in a buzzer round', () => {
    start([round4(1)], 2);
    assert.match(engine.judge('correct').error, /Nobody/);
    engine.buzz('s1');
    assert.match(engine.judge('pass').error, /no passing/);
    assert.match(engine.judge('maybe').error, /Unknown/);
  });

  test('multiple-choice questions cannot be judged by hand', () => {
    start([q(1, 'passing')], 2);
    assert.match(engine.judge('correct').error, /automatically/);
  });

  test('spoken reveals have no stats and the outcome is listed', () => {
    start([round3(1)], 2);
    engine.judge('wrong');
    const result = engine.endQuestion();
    assert.deepEqual(result.stats, {});
    assert.equal(result.correctAnswer, 'Drishyam');
    assert.deepEqual(result.turns, [{ name: 'Player 1', outcome: 'wrong', points: -5 }]);
    assert.equal(byName(1).answers.wrong, 1);
  });

  test('a spoken question in a standard level still reaches a player instead of hanging', () => {
    start([round3(1, { mode: 'standard' })], 2);
    assert.equal(engine.getState().live.holder.name, 'Player 1');
  });

  test('a backup keeps every round setting of the question it replaces', () => {
    start([round3(1), round3(2, { backup: true, afterMiss: 'next', scoring: null })], 2);
    engine.endQuestion({ cancelled: true });
    engine.useBackup(2);
    assert.equal(engine.judge('correct').record.pointsEarned, 10);
  });
});

describe('customisable rounds still play the first way', () => {
  test('fixed points also work with options on the phone', () => {
    start([q(1, 'buzzer', { scoring: { correct: 10, wrong: -5, timeout: 0 } })], 2);
    engine.buzz('s1');
    assert.equal(engine.submitAnswer('s1', 'B').record.pointsEarned, -5);
    engine.buzz('s2');
    assert.equal(engine.submitAnswer('s2', 'A').record.pointsEarned, 10);
  });

  test('a level can set its own time to answer after a buzz', () => {
    start([q(1, 'buzzer', { answerSeconds: 3 })], 1);
    engine.buzz('s1');
    assert.equal(engine.getState().timerMax, 3);
  });

  test('a level set to start at 0 gives the final its own scores; earlier rounds still add up', () => {
    const prelim = (id, level) => q(id, 'standard', { level, levelName: `Round ${level}` });
    const final = (id, level) => q(id, 'buzzer', { level, levelName: `Round ${level}`, resetScores: level === 3, scoring: { correct: 10, wrong: -5, timeout: 0 } });
    start([prelim(1, 1), prelim(2, 2), final(3, 3), final(4, 4)], 1);
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    engine.startQuestion(); // round 2 intro: no reset
    assert.ok(byName(1).score > 0, 'rounds 1 and 2 add together');
    engine.startQuestion();
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    engine.startQuestion(); // round 3 intro: reset
    assert.equal(byName(1).score, 0);
    engine.startQuestion();
    engine.buzz('s1');
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    engine.startQuestion(); // round 4 intro: no reset
    assert.equal(byName(1).score, 10, 'rounds 3 and 4 add together');
  });
});

describe('show-only rounds (the quiz master runs answers and scores by hand)', () => {
  const show = (id, extra = {}) => q(id, 'display', { type: 'short', options: [], correctAnswer: 'Drishyam', ...extra });

  test('nobody can answer or buzz, and the coordinator alone sees the answer', () => {
    start([show(1)], 2);
    assert.equal(engine.getState().manual, true);
    assert.match(engine.submitAnswer('s1', 'Drishyam').error, /out loud/);
    assert.ok(engine.buzz('s1').error);
    assert.equal(engine.hostAnswer().answer, 'Drishyam');
    assert.ok(!JSON.stringify(engine.getState()).includes('Drishyam'));
  });

  test('a question with options shows them but still collects nothing', () => {
    start([q(1, 'display')], 1);
    assert.equal(engine.getState().currentQuestion.options.length, 4);
    assert.match(engine.submitAnswer('s1', 'A').error, /out loud/);
    assert.equal(engine.hostAnswer().answer, 'A');
  });

  test('the timer only shows: it never ends the question', () => {
    start([show(1)], 1);
    assert.ok(engine.questionEndsAt > Date.now());
    assert.equal(engine.timerActs(), false);
  });

  test('a level can run with no timer at all', () => {
    start([show(1, { untimed: true })], 1);
    assert.equal(engine.questionEndsAt, null);
  });

  test('showing the answer changes no score, count, streak or answer time', () => {
    start([show(1)], 2);
    byName(1).score = 750;
    byName(1).streak = 2;
    const result = engine.endQuestion();
    assert.equal(result.mode, 'display');
    assert.equal(result.correctAnswer, 'Drishyam');
    assert.equal(byName(1).score, 750);
    assert.equal(byName(1).streak, 2);
    assert.equal(byName(1).totalResponseTime, 0);
    assert.deepEqual(byName(1).answers, { correct: 0, wrong: 0, skipped: 0 });
    assert.deepEqual(byName(1).roundPoints, {});
  });

  test('the top 5 from the preliminaries still go through, then the rest is by hand', () => {
    const cut = { rule: 'top', value: 1, ties: 'speed' };
    start([q(1, 'standard', { cut }), show(2, { level: 2 }), show(3, { level: 3 })], 2);
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    assert.equal(engine.confirmCut().success, true);
    assert.equal(byName(2).status, 'eliminated');
    engine.startQuestion(); // intro
    engine.startQuestion();
    assert.equal(engine.getState().manual, true);
    engine.endQuestion();
    assert.equal(engine.pendingCut, null, 'a show-only level never proposes a cut');
  });

  test('a game that ends on a show-only round has no winners to show', () => {
    start([q(1, 'standard'), show(2, { level: 2 })], 1);
    assert.equal(engine.getState().manualFinish, true);
  });

  test('a game that ends on a scored round keeps its podium', () => {
    start([show(1), q(2, 'standard', { level: 2 })], 1);
    assert.equal(engine.getState().manualFinish, false);
  });
});

describe('results kept by hand (the buzzer and pass still run)', () => {
  const round4 = (id, extra = {}) => q(id, 'buzzer', { type: 'short', options: [], correctAnswer: 'Drishyam', accepted: 'Papanasam', manualResults: true, untimed: true, answerSeconds: 3, ...extra });
  const round3 = (id, extra = {}) => q(id, 'passing', { type: 'short', options: [], correctAnswer: 'Drishyam', manualResults: true, afterMiss: 'close', ...extra });

  test('buzzer: nobody locks, everyone presses once, and the order is kept', () => {
    start([round4(1)], 3);
    assert.deepEqual(engine.getState().live.presses, []);
    assert.equal(engine.buzz('s2').position, 1);
    assert.equal(engine.buzz('s3').position, 2);
    assert.match(engine.buzz('s2').error, /Already/);
    assert.equal(engine.buzz('s1').position, 3);
    const { live } = engine.getState();
    assert.deepEqual(live.presses.map(p => p.name), ['Player 2', 'Player 3', 'Player 1']);
    assert.equal(live.holder, null);
    assert.equal(live.phase, 'open');
  });

  test('buzzer: there is nothing to mark, and the coordinator moves on', () => {
    start([round4(1)], 2);
    engine.buzz('s1');
    assert.match(engine.judge('wrong').error, /Nobody/);
    assert.equal(engine.getState().live.presses.length, 1);
    assert.equal(engine.hostAnswer().answer, 'Drishyam');
    assert.ok(engine.endQuestion());
  });

  test('a physical buzzer takes its place in the same order', () => {
    start([round4(1)], 2);
    assert.equal(engine.buzz('s2').position, 1);
    assert.equal(engine.buzzFor(byName(1).id).position, 2);
    assert.match(engine.buzzFor(byName(1).id).error, /Already/);
  });

  test('a disqualified player leaves the order and the rest move up', () => {
    start([round4(1)], 3);
    engine.buzz('s1');
    engine.buzz('s2');
    engine.disqualify(byName(1).id, 'test');
    assert.deepEqual(engine.getState().live.presses.map(p => p.name), ['Player 2']);
    assert.match(engine.buzz('s1').error, /out of the game/);
  });

  test('with a timer on, a press after the time is refused', () => {
    start([round4(1, { untimed: false })], 2);
    engine.questionEndsAt = Date.now() - 60000;
    assert.match(engine.buzz('s1').error, /Time/);
  });

  test('a scored buzzer round lets all players press and shows the order', () => {
    start([q(1, 'buzzer')], 2);
    assert.deepEqual(engine.getState().live.presses, []);
    assert.equal(engine.buzz('s1').position, 1);
    assert.equal(engine.buzz('s2').position, 2);
    assert.deepEqual(engine.getState().live.presses.map(p => p.name), ['Player 1', 'Player 2']);
    assert.equal(engine.getState().live.holder.name, 'Player 1');
  });

  test('a scored buzzer round moves to the next presser if the first is wrong', () => {
    start([q(1, 'buzzer')], 3);
    engine.buzz('s1');
    engine.buzz('s2');
    engine.buzz('s3');
    assert.equal(engine.getState().live.holder.name, 'Player 1');
    const r1 = engine.submitAnswer('s1', 'B');
    assert.equal(r1.finished, false);
    assert.equal(engine.getState().live.holder.name, 'Player 2');
    const r2 = engine.submitAnswer('s2', 'C');
    assert.equal(r2.finished, false);
    assert.equal(engine.getState().live.holder.name, 'Player 3');
    const r3 = engine.submitAnswer('s3', 'A');
    assert.equal(r3.finished, true);
    engine.endQuestion();
    assert.equal(byName(1).score, -500);
    assert.equal(byName(2).score, -500);
    assert.equal(byName(3).score, 1000);
  });

  test('no leaderboard in buzzer and turns rounds', () => {
    start([q(1, 'buzzer')], 2);
    assert.equal(engine.getState().standingsHidden, true);
    start([q(1, 'passing')], 2);
    assert.equal(engine.getState().standingsHidden, true);
    start([q(1, 'standard')], 2);
    assert.equal(engine.getState().standingsHidden, false);
  });

  test('no points, counts or round totals are recorded, however many press', () => {
    start([round4(1, { scoring: { correct: 10, wrong: -5, timeout: 0 } })], 2);
    byName(1).score = 750;
    engine.buzz('s1');
    engine.buzz('s2');
    const result = engine.endQuestion();
    assert.equal(result.byHand, true);
    assert.equal(result.mode, 'buzzer');
    assert.equal(byName(1).score, 750);
    assert.equal(byName(2).score, 0);
    assert.deepEqual(engine.answers, {});
    assert.deepEqual(byName(2).roundPoints, {});
    assert.deepEqual(byName(2).answers, { correct: 0, wrong: 0, skipped: 0 });
  });

  test('a phone pass closes the question for that finalist and moves to the reveal', () => {
    start([round3(1), round3(2)], 2);
    assert.equal(engine.getState().live.holder.name, 'Player 1');
    assert.equal(engine.passTurn('s1').finished, true);
    assert.equal(engine.endQuestion().correctAnswer, 'Drishyam');
    engine.startQuestion();
    assert.equal(engine.getState().live.holder.name, 'Player 2');
  });

  test('the coordinator sees the answer, and a game ending this way has no winners', () => {
    start([round4(1)], 2);
    assert.deepEqual(engine.hostAnswer(), { answer: 'Drishyam', accepted: 'Papanasam' });
    assert.equal(engine.getState().manualFinish, true);
    assert.equal(engine.getState().byHand, true);
  });

  test('a multiple-choice buzzer question by hand is answered out loud too', () => {
    start([q(1, 'buzzer', { manualResults: true })], 1);
    assert.equal(engine.buzz('s1').position, 1);
    assert.ok(engine.submitAnswer('s1', 'A').error);
    engine.endQuestion();
    assert.equal(byName(1).score, 0);
  });

  test('the preliminaries still score and cut before the by-hand rounds', () => {
    start([q(1, 'standard'), round3(2, { level: 2 })], 1);
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    assert.ok(byName(1).score > 0);
    assert.equal(engine.getState().revealByHand, false);
  });
});

describe('sudden death', () => {
  const mcqSpare = id => q(id, 'standard', { backup: true });
  const spokenSpare = id => q(id, 'standard', { backup: true, type: 'short', options: [], correctAnswer: 'A' });
  const tied = (n) => { for (let i = 1; i <= n; i++) byName(i).score = 100; };
  const toReveal = (questions, n) => {
    start(questions, n);
    engine.endQuestion();
    tied(n);
  };

  test('a tie for the cut line: fastest correct answer goes through; no score changes', () => {
    const cut = { rule: 'top', value: 1, ties: 'speed' };
    toReveal([q(1, 'standard', { cut }), q(2, 'standard', { level: 2 }), mcqSpare(3)], 2);
    assert.ok(engine.pendingCut || engine.computeCut(1));
    engine.pendingCut = { level: 1, info: engine.levelInfo(1), keep: new Set([byName(1).id]), out: new Set([byName(2).id]) };
    assert.equal(engine.startSuddenDeath([byName(1).id, byName(2).id], 3).success, true);
    assert.equal(engine.state, 'question');
    assert.equal(engine.currentQuestionIndex, 1, 'the running order is untouched');
    engine.submitAnswer('s2', 'A');
    engine.submitAnswer('s1', 'B');
    const result = engine.endQuestion();
    assert.equal(result.suddenDeath.winner, 'Player 2');
    assert.equal(byName(2).score, 100);
    assert.ok(engine.pendingCut.keep.has(byName(2).id));
    assert.ok(engine.pendingCut.out.has(byName(1).id));
    assert.equal(engine.state, 'leaderboard');
    assert.equal(engine.sd, null);
  });

  test('a tie for a prize: buzzers, a wrong answer hands it over, the order changes', () => {
    toReveal([q(1, 'standard'), spokenSpare(2)], 3);
    engine.startSuddenDeath([byName(1).id, byName(2).id], 2);
    assert.equal(engine.getState().live.mode, 'buzzer');
    assert.match(engine.buzz('s3').error, /between other players/);
    engine.buzz('s1');
    assert.equal(engine.judge('wrong').finished, false);
    engine.buzz('s2');
    assert.equal(engine.judge('correct').finished, true);
    engine.endQuestion();
    assert.equal(byName(1).score, 100, 'a wrong answer costs nothing here');
    const order = engine.rankedPlayers().map(p => p.name);
    assert.ok(order.indexOf('Player 2') < order.indexOf('Player 1'));
  });

  test('others cannot answer, and nobody correct leaves the tie for another spare', () => {
    toReveal([q(1, 'standard'), mcqSpare(2), mcqSpare(3)], 3);
    engine.startSuddenDeath([byName(1).id, byName(2).id], 2);
    assert.match(engine.submitAnswer('s3', 'A').error, /between other players/);
    engine.submitAnswer('s1', 'B');
    const result = engine.endQuestion();
    assert.equal(result.suddenDeath.winner, null);
    assert.equal(engine.startSuddenDeath([byName(1).id, byName(2).id], 3).success, true);
  });

  test('a spare is used once, needs two players, and only starts from a reveal', () => {
    start([q(1, 'standard'), mcqSpare(2)], 2);
    assert.match(engine.startSuddenDeath([byName(1).id, byName(2).id], 2).error, /reveal/);
    engine.endQuestion();
    assert.match(engine.startSuddenDeath([byName(1).id], 2).error, /two players/);
    assert.match(engine.startSuddenDeath([byName(1).id, byName(2).id], 99).error, /not available/);
    engine.startSuddenDeath([byName(1).id, byName(2).id], 2);
    engine.endQuestion({ cancelled: true });
    assert.match(engine.startSuddenDeath([byName(1).id, byName(2).id], 2).error, /not available/);
  });

  test('the tie-break adds no answer time', () => {
    toReveal([q(1, 'standard'), mcqSpare(2)], 2);
    const before = byName(1).totalResponseTime;
    engine.startSuddenDeath([byName(1).id, byName(2).id], 2);
    engine.questionStartTime -= 3000;
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    assert.equal(byName(1).totalResponseTime, before);
  });

  test('a sudden death on a preliminary tie does not carry into the final', () => {
    start([q(1, 'standard'), q(2, 'standard', { level: 2, resetScores: true })], 1);
    byName(1).tieBreak = 1;
    engine.endQuestion();
    engine.startQuestion();
    assert.equal(byName(1).tieBreak, 0);
  });
});

describe('final scoreboard', () => {
  test('each round keeps its own points; columns start from the level that resets', () => {
    const bz = (id, level, extra = {}) => q(id, 'buzzer', { level, levelName: `Round ${level}`, scoring: { correct: 10, wrong: -5, timeout: 0 }, ...extra });
    start([q(1, 'standard', { levelName: 'Round 1' }), bz(2, 3, { resetScores: true }), bz(3, 4)], 1);
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    engine.startQuestion();
    engine.startQuestion();
    assert.deepEqual(engine.getState().scoreColumns, ['Round 3']);
    engine.buzz('s1');
    engine.submitAnswer('s1', 'A');
    engine.endQuestion();
    engine.startQuestion();
    engine.startQuestion();
    assert.deepEqual(engine.getState().scoreColumns, ['Round 3', 'Round 4']);
    engine.buzz('s1');
    engine.submitAnswer('s1', 'B');
    engine.endQuestion();
    const p = byName(1);
    assert.equal(p.score, 5);
    assert.equal(p.roundPoints['Round 3'], 10);
    assert.equal(p.roundPoints['Round 4'], -5);
    assert.ok(p.roundPoints['Round 1'] > 0, 'kept for the results file');
  });
});

describe('physical buzzers and registered names', () => {
  test('a key press at the host console buzzes for that player', () => {
    start([q(1, 'buzzer')], 2);
    assert.equal(engine.buzzFor(byName(2).id).position, 1);
    assert.equal(engine.getState().live.holder.name, 'Player 2');
    assert.equal(engine.buzzFor(byName(1).id).position, 2);
    assert.match(engine.buzzFor(byName(2).id).error, /already/i);
  });

  test('two players with the same registered name are told apart by ticket', () => {
    engine.setQuestions([q(1, 'standard')]);
    engine.addPlayer('s1', 'Anu Thomas', '', { ticketId: 'MMP1111', fullName: 'Anu Thomas' });
    const second = engine.addPlayer('s2', 'Anu Thomas', '', { ticketId: 'MMP2222', fullName: 'Anu Thomas' });
    assert.equal(second.success, true);
    assert.equal(second.player.name, 'Anu Thomas #2222');
  });
});

describe('questions without text', () => {
  test('a picture-only question plays and hides nothing it should show', () => {
    start([q(1, 'standard', { text: '', image: { mime: 'image/jpeg', data: 'x' } })], 1);
    const s = engine.getState();
    assert.equal(s.currentQuestion.text, '');
    assert.equal(s.currentQuestion.hasImage, true);
    assert.equal(s.currentQuestion.correctAnswer, undefined);
  });

  test('an audio question plays its clip before the question, like a video', () => {
    start([q(1, 'standard', { text: '', video: { mime: 'audio/mpeg', url: 'https://x/clip' } })], 1);
    assert.equal(engine.state, 'video');
    assert.equal(engine.getState().video.mime, 'audio/mpeg');
    assert.equal(engine.getState().currentQuestion, null);
    engine.startQuestion();
    assert.equal(engine.state, 'question');
  });

  test('a buzzer question with a clip opens the buzzers only after the clip', () => {
    start([q(1, 'buzzer', { video: { mime: 'audio/mpeg', url: 'https://x/clip' } })], 1);
    assert.ok(engine.buzz('s1').error);
    engine.startQuestion();
    assert.equal(engine.buzz('s1').success, true);
  });
});
