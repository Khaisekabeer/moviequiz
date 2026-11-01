import React, { useState, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useCountdown } from '../hooks/useCountdown';
import { Avatar, Burst, ComicBg, Rise, Spinner, TimerRing, VyuhamLogo, OPTION_LABELS, ROUND_LABEL, roundRule, ordinal, cumulative, byCumulative } from '../components/ui';
import { API_BASE } from '../lib/api';
import { avatarChoices } from '../lib/avatar';
import confetti from 'canvas-confetti';

const TOKEN_KEY = 'vyuham_player_token';
// The player's own count of answers over the whole game.
const tally = (a?: { correct: number; wrong: number; skipped: number }) => (a ? `${a.correct} right · ${a.wrong} wrong · ${a.skipped} skipped` : '');

// localStorage can throw (private mode, blocked storage); the game still works without it.
const storage = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* ignore */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

const screenPad: CSSProperties = { width: '100%', maxWidth: 460, margin: '0 auto', padding: '0 20px' };

// A themed phone screen: comic backdrop + content. Event theme outside levels, level theme inside.
function Screen({ theme, children, style }: { theme: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="stage" data-theme={theme} style={style}>
      <ComicBg slashes={theme === 'pop'} />
      {children}
    </div>
  );
}

export default function ParticipantView() {
  const { socket, isConnected } = useSocket();
  const [name, setName] = useState('');
  const [ticketId, setTicketId] = useState('');
  // Continuing on a new device: the server asks for the last 4 digits of the registered phone.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [verify, setVerify] = useState('');
  // Character picked on the join screen.
  const [avatarOptions, setAvatarOptions] = useState<string[]>(() => avatarChoices(12));
  const [avatar, setAvatar] = useState('');
  const [requireCheckin, setRequireCheckin] = useState(true);
  const [joining, setJoining] = useState(false);
  const [gameState, setGameState] = useState<any>(null);
  const [playerInfo, setPlayerInfo] = useState<any>(null);
  const [answerResult, setAnswerResult] = useState<any>(null);
  // Our place among the players still in: { rank, of, atRisk, cutLabel }.
  const [standing, setStanding] = useState<any>(null);
  // End of a round: { round, levelName, isFinal, cutPending, cutLabel, eliminated } until the next question.
  const [roundEnd, setRoundEnd] = useState<any>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [rejoining, setRejoining] = useState(() => !!storage.get());
  const questionIdRef = useRef<number | null>(null);

  const timeLeft = useCountdown(
    gameState?.state === 'question' ? gameState.questionEndsAt : null,
    gameState?.serverNow,
  );
  const maxTime = gameState?.timerMax || gameState?.currentQuestion?.timeLimit || 20;
  const chosenAvatar = avatar || avatarOptions[0];

  // Clear per-question UI only when a *new* question starts (not on repeated state broadcasts).
  const applyState = (state: any) => {
    setGameState(state);
    if (state.state !== 'leaderboard') setRoundEnd(null);
    if (state.live?.phase === 'open') setMessage(''); // "someone else buzzed first" is over
    if (state.state === 'question' && state.currentQuestion?.id !== questionIdRef.current) {
      questionIdRef.current = state.currentQuestion?.id ?? null;
      setSelectedOption(null);
      setAnswerResult(null);
      setMessage('');
    }
  };

  const leaveGame = (reason: string) => {
    storage.clear();
    setPlayerInfo(null);
    setGameState(null);
    setAnswerResult(null);
    setStanding(null);
    setSelectedOption(null);
    questionIdRef.current = null;
    setMessage(reason);
  };

  useEffect(() => {
    socket.on('game_state', applyState);
    socket.on('kicked', () => {
      leaveGame('You were removed by the host.');
      setTimeout(() => socket.connect(), 500); // the server closed our connection
    });
    socket.on('game_reset', () => leaveGame('The game was reset. Join again to play.'));
    // Our own result for the question that just ended (and our place among those still in).
    socket.on('my_result', (res: any) => {
      setPlayerInfo(res.player);
      setAnswerResult(res.myAnswer);
      setStanding(res.standing ?? null);
      setRoundEnd(res.roundEnd ?? null);
      if (res.myAnswer?.isCorrect) {
        confetti({ particleCount: 70, spread: 60, origin: { y: 0.7 }, colors: ['#3da9fc', '#ff5c8a', '#ffc531', '#3ddc97'] });
        if (navigator.vibrate) navigator.vibrate(150);
      } else if (res.myAnswer) {
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
      }
    });
    // Status changes outside a reveal: eliminated or disqualified by the host, or the end-of-round cut.
    socket.on('player_update', (res: any) => {
      setPlayerInfo(res.player);
      setStanding(res.standing ?? null);
      if (!res.roundEnd) return;
      setRoundEnd(res.roundEnd);
      if (res.player?.status === 'active') {
        confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 }, colors: ['#3da9fc', '#ff5c8a', '#ffc531', '#3ddc97'] });
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      } else if (navigator.vibrate) {
        navigator.vibrate(400);
      }
    });
    return () => {
      socket.off('game_state');
      socket.off('kicked');
      socket.off('game_reset');
      socket.off('my_result');
      socket.off('player_update');
    };
  }, [socket]);

  // Tell the server when the quiz page is hidden during a question (switching apps or tabs).
  // Staff see it as a flag; nothing happens automatically.
  const answering = !!playerInfo && playerInfo.status === 'active' && gameState?.state === 'question';
  useEffect(() => {
    if (!answering) return;
    const report = () => socket.emit('screen', { hidden: document.visibilityState === 'hidden' });
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [socket, answering]);

  // Reclaim our seat after a refresh or a dropped connection.
  useEffect(() => {
    if (!isConnected) return;
    const token = storage.get();
    if (!token) {
      setRejoining(false);
      return;
    }
    socket.emit('rejoin_game', token, (res: any) => {
      setRejoining(false);
      if (!res?.success) {
        storage.clear();
        return;
      }
      setPlayerInfo(res.player);
      questionIdRef.current = res.gameState.currentQuestion?.id ?? null;
      setGameState(res.gameState);
      setSelectedOption(res.myAnswer?.answer ?? null);
      setAnswerResult(res.myAnswer);
      setStanding(res.standing ?? null);
      setRoundEnd(res.roundEnd ?? null);
    });
  }, [socket, isConnected]);

  // Whether players join with a ticket ID (check-in required) or just a name.
  useEffect(() => {
    fetch(`${API_BASE}/api/config`).then(r => r.json()).then(c => setRequireCheckin(c.requireCheckin !== false)).catch(() => {});
    const onConfig = (c: any) => setRequireCheckin(c.requireCheckin !== false);
    socket.on('config', onConfig);
    return () => { socket.off('config', onConfig); };
  }, [socket]);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (requireCheckin ? !ticketId.trim() : !name.trim()) return;
    setMessage('');
    setJoining(true);
    const payload = requireCheckin
      ? { ticketId: ticketId.trim(), name: name.trim(), avatar: chosenAvatar, ...(needsVerify ? { verify: verify.trim() } : {}) }
      : { name: name.trim(), avatar: chosenAvatar };
    socket.emit('join_game', payload, (res: any) => {
      setJoining(false);
      if (res.success) {
        storage.set(res.token);
        setPlayerInfo(res.player);
        setNeedsVerify(false);
        setVerify('');
      } else {
        if (res.needsVerify) setNeedsVerify(true);
        setMessage(res.error);
      }
    });
  };

  const handleAnswer = (option: string) => {
    if (selectedOption || gameState?.state !== 'question') return;
    setSelectedOption(option);
    socket.emit('submit_answer', option, (res: any) => {
      if (!res.success) {
        setSelectedOption(null);
        setMessage(res.error);
        return;
      }
      // Right/wrong is only revealed when the question ends (my_result).
      setAnswerResult({ answer: option, success: true });
    });
  };

  // Buzzer round: the server decides who was first. Passing round: hand the question on.
  const handleBuzz = () => {
    if (navigator.vibrate) navigator.vibrate(60);
    socket.emit('buzz', (res: any) => { if (!res.success) setMessage(res.error); });
  };
  const handlePass = () => {
    socket.emit('pass_turn', (res: any) => { if (!res.success) setMessage(res.error); });
  };

  const levelTheme = gameState?.levelConfig?.theme ?? 'marquee';
  const center: CSSProperties = { ...screenPad, flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 18 };

  // ─── Connecting ────────────────────────────────────────────────────────────
  if (!isConnected || rejoining) {
    return <Spinner label={playerInfo ? 'Reconnecting…' : 'Connecting…'} />;
  }

  // ─── Join ──────────────────────────────────────────────────────────────────
  if (!playerInfo) {
    return (
      <Screen theme="marquee">
        <header style={{ ...screenPad, paddingTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <VyuhamLogo height={46} />
          <span className="comic-badge light" style={{ fontSize: '0.8rem' }}>Vyuham '26</span>
        </header>

        <main style={{ ...screenPad, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingBottom: 28, gap: 18 }}>
          <Rise style={{ alignSelf: 'center' }}>
            <Burst style={{ padding: '30px 34px 34px' }}>
              <h1 className="comic-title slam" style={{ fontSize: 'clamp(3.2rem, 17vw, 5rem)', textAlign: 'center' }}>Movie<br />Quiz</h1>
            </Burst>
          </Rise>

          <Rise d={200}>
            <form onSubmit={handleJoin} className="comic-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="comic-text" style={{ fontSize: '1.05rem' }}>Pick your character</span>
                <button type="button" className="chip" onClick={() => { setAvatarOptions(avatarChoices(12)); setAvatar(''); }}>↻ Shuffle</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }} role="radiogroup" aria-label="Character">
                {avatarOptions.map(id => (
                  <button key={id} type="button" role="radio" aria-checked={chosenAvatar === id}
                    className={`avatar-pick${chosenAvatar === id ? ' picked' : ''}`} onClick={() => setAvatar(id)}>
                    <Avatar id={id} size="100%" style={{ aspectRatio: '1', display: 'block' }} />
                  </button>
                ))}
              </div>

              {requireCheckin && (
                <>
                  <label htmlFor="player-ticket" className="eyebrow" style={{ marginTop: 4 }}>Ticket ID (on your pass)</label>
                  <input
                    id="player-ticket" className="field" type="text" value={ticketId}
                    onChange={(e) => { setTicketId(e.target.value.toUpperCase()); setNeedsVerify(false); setVerify(''); }}
                    maxLength={40} placeholder="e.g. MMP49081761" autoCapitalize="characters" autoComplete="off" spellCheck={false} required
                    style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
                  />
                  {needsVerify && (
                    <>
                      <label htmlFor="player-verify" className="eyebrow">Last 4 digits of your registered phone</label>
                      <input
                        id="player-verify" className="field" type="text" inputMode="numeric" pattern="[0-9]{4}" value={verify}
                        onChange={(e) => setVerify(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="••••" autoComplete="off" required autoFocus
                        style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.3em' }}
                      />
                    </>
                  )}
                </>
              )}
              {/* With check-in, players appear under their registered name. */}
              {!requireCheckin && (
                <>
                  <label htmlFor="player-name" className="eyebrow">Your name</label>
                  <input
                    id="player-name" className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
                    placeholder="Your full name" autoComplete="name" required
                  />
                </>
              )}
              <button type="submit" className="btn btn-heat btn-lg btn-block" disabled={joining}>
                {joining ? 'Checking ticket…' : "Let's play!"}
              </button>
              {message && <p role="alert" className="error-text">{message}</p>}
            </form>
          </Rise>
        </main>
      </Screen>
    );
  }

  // ─── Lobby ─────────────────────────────────────────────────────────────────
  if (!gameState || gameState.state === 'lobby') {
    return (
      <Screen theme="marquee">
        <header style={{ ...screenPad, paddingTop: 18 }}><VyuhamLogo height={42} /></header>
        <main style={center}>
          <Rise><span className="comic-badge">You're in!</span></Rise>
          <div className="pop"><Avatar id={playerInfo.avatar} size={150} style={{ border: '4px solid var(--t-ink)', boxShadow: '5px 5px 0 var(--t-ink)' }} /></div>
          <Burst style={{ padding: '18px 30px 22px' }}>
            <h1 className="comic-title" style={{ fontSize: 'clamp(2.4rem, 13vw, 4rem)', overflowWrap: 'anywhere' }}>{playerInfo.name}</h1>
          </Burst>
          <Rise d={300} as="p" className="comic-text" style={{ margin: 0, fontSize: '1.15rem', lineHeight: 1.4 }}>
            Waiting for the host to begin.<br />Keep your eyes on the big screen!
          </Rise>
        </main>
      </Screen>
    );
  }

  // ─── Out of the game: cut after a level, or disqualified ───────────────────
  if (playerInfo.status && playerInfo.status !== 'active' && gameState.state !== 'podium') {
    const exit = playerInfo.exit || {};
    const disqualified = playerInfo.status === 'disqualified';
    const byHost = !disqualified && exit.reason === 'manual';
    return (
      <Screen theme={disqualified ? 'classic' : levelTheme}>
        <main style={center}>
          <Rise><span className="comic-badge">{disqualified ? 'Disqualified' : `Out after round ${exit.round ?? ''}`}</span></Rise>
          <Avatar id={playerInfo.avatar} size={110} style={{ filter: 'grayscale(0.6)', border: '3px solid var(--t-ink, #111)' }} />
          <Burst style={{ padding: '20px 28px 24px' }}>
            <h1 className="comic-title" style={{ fontSize: 'clamp(2.2rem, 11vw, 3.4rem)', textAlign: 'center' }}>
              {disqualified ? 'Disqualified' : byHost ? 'Eliminated' : "Didn't make the cut"}
            </h1>
          </Burst>
          <div className="comic-panel" style={{ padding: '14px 18px', lineHeight: 1.5 }}>
            {disqualified
              ? (exit.note || 'The quiz host removed you from the game.')
              : <>{String(exit.note || 'Eliminated').replace(/\.$/, '')}.<br />You finished <strong>#{exit.rank}</strong> with <strong>{exit.score}</strong> points.<br />{tally(playerInfo.answers)}</>}
          </div>
          <p className="comic-text" style={{ margin: 0, fontSize: '1rem' }}>
            {disqualified ? 'Speak to the quiz desk if you think this is a mistake' : 'Stay and watch the rest on the big screen!'}
          </p>
        </main>
      </Screen>
    );
  }

  // ─── Level intro ───────────────────────────────────────────────────────────
  if (gameState.state === 'intro') {
    const config = gameState.levelConfig || {};
    return (
      <Screen theme={levelTheme}>
        <main style={center}>
          <Rise><span className="comic-badge light">Round {gameState.currentLevel} of {gameState.totalLevels}</span></Rise>
          <Burst style={{ padding: '34px 30px 40px' }}>
            <h1 className="comic-title slam" style={{ fontSize: 'clamp(2.6rem, 14vw, 4.4rem)', textAlign: 'center' }}>{config.name}</h1>
          </Burst>
          <Rise d={350} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {ROUND_LABEL[config.mode] && <span className="comic-badge">{ROUND_LABEL[config.mode]}</span>}
            {gameState.rules?.multiplier !== false && <span className="comic-badge">× {config.multiplier} points</span>}
            {config.cut && <span className="comic-badge light">✂ {config.cut.label}</span>}
            {gameState.rules?.roundReset && <span className="comic-badge light">Everyone starts this round at 0</span>}
          </Rise>
          {roundRule(config) && <Rise d={500} as="p" className="comic-text" style={{ margin: 0, fontSize: '1.05rem' }}>{roundRule(config)}</Rise>}
        </main>
      </Screen>
    );
  }

  // ─── Video: plays on the projector before the question and timer ───────────
  if (gameState.state === 'video') {
    const audio = String(gameState.video?.mime).startsWith('audio/');
    return (
      <Screen theme={levelTheme}>
        <main style={center}>
          <Rise><span className="comic-badge">{audio ? 'Audio' : 'Video'}</span></Rise>
          <Burst style={{ padding: '26px 30px 30px' }}>
            <h1 className="comic-title slam" style={{ fontSize: 'clamp(2.4rem, 12vw, 3.8rem)', textAlign: 'center' }}>{audio ? 'Listen up!' : 'Watch the big screen!'}</h1>
          </Burst>
          <Rise d={300} as="p" className="comic-text" style={{ margin: 0, fontSize: '1.05rem' }}>The question and timer start after the {audio ? 'clip' : 'video'}.</Rise>
        </main>
      </Screen>
    );
  }

  // ─── Question ──────────────────────────────────────────────────────────────
  if (gameState.state === 'question') {
    const q = gameState.currentQuestion;
    const timeUp = timeLeft <= 0;
    const live = gameState.live;
    const myTurn = live?.holder?.id === playerInfo.id;
    const spoken = !!q?.spoken;
    const watching = gameState.suddenDeath && !gameState.suddenDeath.players.some((x: any) => x.id === playerInfo.id);
    if (gameState.manual) return <WatchTheScreen theme={levelTheme} title="Watch the big screen!" detail="Answers are given out loud in this round." />;
    if (watching) {
      return (
        <Screen theme={levelTheme}>
          <main style={center}>
            <Rise><span className="comic-badge">⚡ Sudden death</span></Rise>
            <div className="comic-panel" style={{ padding: '14px 20px' }}>
              <div className="comic-text" style={{ fontSize: '1.4rem' }}>{gameState.suddenDeath.players.map((x: any) => x.name).join(' vs ')}</div>
              <p style={{ margin: '6px 0 0' }}>Watch the big screen.</p>
            </div>
          </main>
        </Screen>
      );
    }
    return (
      <Screen theme={levelTheme}>
        <header style={{ ...screenPad, display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, paddingBottom: 8 }}>
          <span className="comic-badge light" style={{ fontSize: '1.2rem' }}>
            Q{gameState.currentQuestionIndex + 1}<span style={{ opacity: 0.5 }}>/{gameState.totalQuestions}</span>
          </span>
          <span className="comic-badge" style={{ fontSize: '0.75rem', maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gameState.levelConfig?.name}</span>
          {gameState.questionEndsAt && <div className="timer-disc"><TimerRing value={timeLeft} max={maxTime} size={58} stroke={4} /></div>}
        </header>

        <main style={{ ...screenPad, flex: 1, display: 'flex', flexDirection: 'column', paddingTop: 8, paddingBottom: 16, gap: 10 }}>
          <p className="comic-text" style={{ margin: '0 0 4px', textAlign: 'center', fontSize: '1.05rem' }}>
            {myTurn ? (live.mode === 'buzzer' ? (live.out?.length ? "It's your turn to answer!" : 'You buzzed first!') : "It's your turn!") : 'Read the question on the big screen'}
          </p>

          {myTurn && spoken ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Burst style={{ padding: '30px 34px 34px' }}>
                <h1 className="comic-title slam" style={{ fontSize: 'clamp(2.4rem, 12vw, 3.8rem)', textAlign: 'center' }}>Say your answer!</h1>
              </Burst>
            </div>
          ) : live && !myTurn ? <TurnWait live={live} playerId={playerInfo.id} onBuzz={handleBuzz} /> : <div style={{ flex: 1, maxHeight: 520, display: 'grid', gridAutoRows: 'minmax(60px, 1fr)', gap: 10 }}>
            {q?.options?.map((opt: string, idx: number) => {
              const isSelected = selectedOption === opt;
              const isDisabled = selectedOption !== null || timeUp;
              let cls = 'opt-btn pop';
              if (isSelected) cls += ' selected';
              else if (isDisabled) cls += ' faded';
              return (
                <button key={idx} data-opt={idx} className={cls} style={{ ['--d' as string]: `${idx * 70}ms` }}
                  onClick={() => handleAnswer(opt)} disabled={isDisabled}>
                  <span className="opt-label">{OPTION_LABELS[idx]}</span>
                  <span className="opt-text">{opt}</span>
                </button>
              );
            })}
          </div>}

          {myTurn && live.mode === 'passing' && !selectedOption && (
            <button type="button" className="btn btn-heat btn-lg btn-block" onClick={handlePass}>Pass →</button>
          )}

          {message && <p role="alert" className="error-text" style={{ marginTop: 6 }}>{message}</p>}
          {(!live || myTurn) && !spoken && (selectedOption || timeUp) && (
            <p className="comic-text" style={{ margin: 0, textAlign: 'center', fontSize: '1.05rem' }}>
              {selectedOption ? '● Locked in — wait for the reveal!' : "Time's up — wait for the reveal"}
            </p>
          )}
        </main>
      </Screen>
    );
  }

  // ─── Podium: final rank ────────────────────────────────────────────────────
  if (gameState.state === 'podium' && gameState.manualFinish) {
    return <WatchTheScreen theme="marquee" title="That's a wrap!" detail="The quiz master will announce the winners. Thanks for playing Movie Quiz · Vyuham '26" />;
  }
  if (gameState.state === 'podium') {
    const board: any[] = gameState.finalLeaderboard || [];
    const disqualified = playerInfo.status === 'disqualified';
    const ranked = byCumulative(board.filter(p => p.status !== 'disqualified'));
    const rank = disqualified ? 0 : ranked.findIndex(p => p.id === playerInfo.id) + 1;
    const me = ranked[rank - 1];
    const medal = disqualified ? 'Disqualified' : playerInfo.status === 'active' ? 'Selected!' : 'Final standing';
    return (
      <Screen theme="marquee">
        <main style={center}>
          <Rise><span className="comic-badge">{medal}</span></Rise>
          <Avatar id={playerInfo.avatar} size={120} style={{ border: '4px solid var(--t-ink)', boxShadow: '5px 5px 0 var(--t-ink)' }} />
          {rank > 0 ? (
            <>
              <Burst style={{ padding: '24px 40px 30px' }}>
                <div className="comic-title slam" style={{ fontSize: 'clamp(5rem, 30vw, 8rem)' }}><span style={{ fontSize: '0.5em' }}>#</span>{rank}</div>
              </Burst>
              <span className="comic-badge light">{me ? cumulative(me) : 0} points · of {ranked.length}</span>
            </>
          ) : (
            <h1 className="comic-title" style={{ fontSize: '3rem' }}>Game over</h1>
          )}
          {playerInfo.answers && <p className="comic-text" style={{ margin: 0 }}>{tally(playerInfo.answers)}</p>}
          <VyuhamLogo height={54} style={{ marginTop: 10 }} />
          <p className="comic-text" style={{ margin: 0 }}>Thanks for playing Movie Quiz · Vyuham '26</p>
        </main>
      </Screen>
    );
  }

  // ─── Reveal: result of the last question ───────────────────────────────────
  if (gameState.revealByHand) {
    return <WatchTheScreen theme={levelTheme} title="Watch the big screen!" detail="The answer is on the big screen." />;
  }
  if (gameState.state === 'leaderboard') {
    const isCorrect = answerResult?.isCorrect;
    const notAnswered = !answerResult;
    const cancelled = !!gameState.cancelled;
    // Buzzer and passing rounds: not everyone holds every question.
    const turnRound = !!gameState.revealMode && gameState.revealMode !== 'standard';
    const sidelined = turnRound && notAnswered;
    const passed = !notAnswered && !isCorrect && !answerResult.answer;
    const penalty = (answerResult?.points ?? 0) < 0 ? answerResult.points : 0;
    const tieBreak = gameState.suddenDeathResult;
    const wonTie = tieBreak?.winner === playerInfo.name;
    const headline = tieBreak && !cancelled ? (wonTie ? 'You won it!' : tieBreak.players.includes(playerInfo.name) ? (tieBreak.winner ? 'Tie-break lost' : 'Still tied') : 'Tie-break over')
      : cancelled ? 'Cancelled' : sidelined ? 'Next one!' : passed && !penalty ? 'Passed' : notAnswered ? 'Too slow!' : isCorrect ? 'Correct!' : 'Wrong!';
    const tone = cancelled || notAnswered || (passed && !penalty) ? '#9ca3af' : isCorrect ? '#22c55e' : '#ef4444';
    const midRound = roundEnd && !roundEnd.isFinal;
    return (
      <Screen theme={levelTheme}>
        <main style={center}>
          <Burst style={{ padding: '26px 34px 30px' }}>
            <div style={{ textAlign: 'center' }}>
              <div className="comic-title pop" style={{ fontSize: '4.2rem', color: tone }} aria-hidden="true">
                {cancelled ? '–' : sidelined ? '★' : passed && !penalty ? '→' : notAnswered ? '⧗' : isCorrect ? '✓' : '✕'}
              </div>
              <h1 className="comic-title slam" style={{ fontSize: 'clamp(2.6rem, 14vw, 4rem)', color: tone }}>{headline}</h1>
            </div>
          </Burst>

          {isCorrect && !tieBreak ? (
            <Rise d={250} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <span className="comic-badge" style={{ fontSize: '1.4rem' }}>+{answerResult.points}</span>
              {answerResult.badge && <span className="comic-badge light">★ {answerResult.badge}</span>}
            </Rise>
          ) : (
            <Rise d={250} as="p" className="comic-text" style={{ margin: 0, fontSize: '1.05rem' }}>
              {tieBreak && !cancelled ? (tieBreak.winner ? `${tieBreak.winner} takes the higher place. Scores don't change.` : 'Nobody got it. The host may play another.') : cancelled ? 'This question was cancelled. It does not count for anyone.' : sidelined ? "This one didn't reach you. Stay sharp!" : penalty ? `${penalty} points.` : passed ? 'No points lost.' : notAnswered ? "You didn't answer in time." : `0 points this time.${gameState.rules?.streak === false ? '' : ' Streak reset.'}`}
            </Rise>
          )}

          {gameState.answerNote && (
            <Rise d={360} as="p" className="comic-panel" style={{ margin: 0, padding: '10px 16px', fontSize: '0.95rem', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
              {gameState.answerNote}
            </Rise>
          )}

          {midRound && <RoundEndNotice roundEnd={roundEnd} standing={standing} />}

          <Rise d={480} className="comic-panel" style={{ width: '100%', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <Avatar id={playerInfo.avatar} size={52} />
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div className="eyebrow" style={{ color: '#555' }}>{gameState.rules?.roundReset ? 'Round points' : 'Your total'}</div>
              <div className="comic-text tabular" style={{ fontSize: '2rem', lineHeight: 1 }}>{playerInfo.score ?? 0}</div>
            </div>
            {standing && !gameState.standingsHidden && (
              <div style={{ textAlign: 'right' }}>
                <div className="eyebrow" style={{ color: '#555' }}>Rank</div>
                <div className="comic-text tabular" style={{ fontSize: '2rem', lineHeight: 1 }}>#{standing.rank}<span style={{ fontSize: '1rem', opacity: 0.6 }}>/{standing.of}</span></div>
              </div>
            )}
          </Rise>
          {standing?.cutLabel && !midRound && !gameState.standingsHidden && (
            <Rise d={560}>
              <span className="comic-badge light" style={{ background: standing.atRisk ? '#fee2e2' : '#dcfce7' }}>
                {standing.atRisk ? `⚠ ${standing.cutLabel} — you're below the line!` : `✓ ${standing.cutLabel} — keep it up!`}
              </span>
            </Rise>
          )}
          {gameState.standingsHidden && (
            <Rise d={560}><span className="comic-badge light">{gameState.levelConfig?.mode === 'buzzer' || gameState.levelConfig?.mode === 'passing' ? 'Standings hidden for this round' : 'Final round — standings at the end'}</span></Rise>
          )}
        </main>
      </Screen>
    );
  }

  return null;
}

// Show-only rounds and the end of a final run by hand: nothing to do on the phone.
function WatchTheScreen({ theme, title, detail }: { theme: string; title: string; detail: string }) {
  return (
    <Screen theme={theme}>
      <main style={{ ...screenPad, flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 18 }}>
        <Burst style={{ padding: '26px 30px 30px' }}>
          <h1 className="comic-title slam" style={{ fontSize: 'clamp(2.4rem, 12vw, 3.8rem)', textAlign: 'center' }}>{title}</h1>
        </Burst>
        <Rise d={300} as="p" className="comic-text" style={{ margin: 0, fontSize: '1.05rem' }}>{detail}</Rise>
      </main>
    </Screen>
  );
}

// Buzzer and passing rounds, while someone else holds the question or the buzzers are open.
function TurnWait({ live, playerId, onBuzz }: { live: any; playerId: string; onBuzz: () => void }) {
  const lockedOut = live.out.includes(playerId);
  const box: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center' };
  if (live.presses?.some((p: any) => p.id === playerId)) {
    const place = live.presses.findIndex((p: any) => p.id === playerId) + 1;
    return (
      <div style={box}>
        <Burst style={{ padding: '30px 34px 34px' }}>
          <h1 className="comic-title slam" style={{ fontSize: 'clamp(2.8rem, 15vw, 4.4rem)', textAlign: 'center' }}>{ordinal(place)}!</h1>
        </Burst>
        <div className="comic-panel" style={{ padding: '14px 20px' }}>
          <div className="comic-text" style={{ fontSize: '1.4rem', lineHeight: 1.15 }}>You buzzed {ordinal(place)}</div>
          <p style={{ margin: '6px 0 0', fontSize: '0.95rem' }}>{lockedOut ? 'You had your go on this one.' : 'Watch the big screen.'}</p>
        </div>
      </div>
    );
  }
  if (live.mode === 'buzzer' && !lockedOut) {
    return <div style={box}><button type="button" className="buzz-btn pop" onClick={onBuzz}>Buzz!</button></div>;
  }
  return (
    <div style={box}>
      {live.holder && <Avatar id={live.holder.avatar} size={110} />}
      <div className="comic-panel" style={{ padding: '14px 20px' }}>
        <div className="comic-text" style={{ fontSize: '1.5rem', lineHeight: 1.15 }}>
          {live.holder ? (live.mode === 'buzzer' ? `${live.holder.name} buzzed!` : `${live.holder.name}'s turn`) : "You're locked out"}
        </div>
        <p style={{ margin: '6px 0 0', fontSize: '0.95rem' }}>
          {lockedOut ? 'You had your go on this one.' : live.mode === 'buzzer' ? 'If they miss, the next in order answers.' : live.afterMiss === 'close' ? 'Your turn is coming.' : 'It may pass to you — be ready!'}
        </p>
      </div>
    </div>
  );
}

// Shown on the reveal at the end of a round: the cut is being decided, or we made it through.
function RoundEndNotice({ roundEnd, standing }: { roundEnd: any; standing: any }) {
  return (
    <Rise d={380} className="comic-panel" style={{ width: '100%', padding: '12px 16px', textAlign: 'left' }}>
      <div className="eyebrow" style={{ color: '#555' }}>Round {roundEnd.round} complete · {roundEnd.levelName}</div>
      {roundEnd.cutPending ? (
        <>
          <div className="comic-text" style={{ fontSize: '1.5rem', marginTop: 4 }}>The cut is coming…</div>
          <p style={{ margin: '4px 0 0', fontSize: '0.9rem', lineHeight: 1.45 }}>
            {roundEnd.cutLabel}. {standing?.atRisk ? "You're below the line right now — the host is confirming." : 'The host is confirming who goes through.'}
          </p>
        </>
      ) : (
        <>
          <div className="comic-text" style={{ fontSize: '1.5rem', marginTop: 4, color: '#16a34a' }}>🎉 You're through to round {roundEnd.round + 1}!</div>
          <p style={{ margin: '4px 0 0', fontSize: '0.9rem', lineHeight: 1.45 }}>
            {standing ? <>You're <strong>#{standing.rank}</strong> of {standing.of} still in.</> : null}
            {roundEnd.eliminated > 0 ? ` ${roundEnd.eliminated} player${roundEnd.eliminated === 1 ? '' : 's'} eliminated.` : ''}
          </p>
        </>
      )}
    </Rise>
  );
}
