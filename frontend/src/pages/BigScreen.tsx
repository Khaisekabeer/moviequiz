import { useLayoutEffect, useRef, useState, useEffect, type CSSProperties, type ReactNode } from 'react';
import confetti from 'canvas-confetti';
import { useSocket } from '../contexts/SocketContext';
import { useCountdown } from '../hooks/useCountdown';
import { Avatar, Burst, ComicBg, QrCode, Rise, TimerRing, VyuhamLogo, OPTION_LABELS, ROUND_LABEL, roundRule } from '../components/ui';
import { Standings } from '../components/Standings';
import QuestionPicture from '../components/QuestionPicture';
import QuestionVideo, { type VideoCommand } from '../components/QuestionVideo';
import QuestionText from '../components/QuestionText';

const PHASE_LABEL: Record<string, string> = {
  lobby: 'Join now',
  intro: 'Get ready',
  video: 'Clip',
  question: 'Question live',
  leaderboard: 'Reveal',
  podium: 'Final results',
};

// The projector. Lobby and podium use the event theme; each level brings its own theme
// (set by the quiz master), so every round looks different.
export default function BigScreen() {
  const { socket, isConnected } = useSocket();
  const [gameState, setGameState] = useState<any>(null);
  const [players, setPlayers] = useState<any[]>([]);
  const [questionResult, setQuestionResult] = useState<any>(null);
  const [answerCount, setAnswerCount] = useState({ answered: 0, total: 0 });
  const [serverInfo, setServerInfo] = useState<{ lanAddresses: string[] } | null>(null);
  const [videoCommand, setVideoCommand] = useState<VideoCommand | null>(null);

  const timeLeft = useCountdown(
    gameState?.state === 'question' ? gameState.questionEndsAt : null,
    gameState?.serverNow,
  );
  const maxTime = gameState?.timerMax || gameState?.currentQuestion?.timeLimit || 20;

  useEffect(() => {
    if (!isConnected) return;

    socket.on('game_state', (state) => {
      setGameState(state);
      if (state.state === 'question') setQuestionResult(null);
      if (state.state !== 'video') setVideoCommand(null);
    });
    socket.on('players_list', setPlayers);
    socket.on('answer_count', setAnswerCount);
    socket.on('server_info', setServerInfo);
    socket.on('question_result', setQuestionResult);
    socket.on('video_control', setVideoCommand);
    // The coordinator confirmed the end-of-round cut: show who went out, then only the survivors.
    socket.on('cut_result', (data: any) => setQuestionResult((prev: any) => ({
      ...prev, leaderboard: data.leaderboard, elimination: data.elimination, pendingCut: null, atRisk: [],
      roundEnd: prev?.roundEnd && { ...prev.roundEnd, cutPending: false },
    })));
    socket.emit('join_role', 'bigscreen');

    return () => {
      socket.off('game_state');
      socket.off('players_list');
      socket.off('answer_count');
      socket.off('server_info');
      socket.off('question_result');
      socket.off('video_control');
      socket.off('cut_result');
    };
  }, [socket, isConnected]);

  // The address players should type: this page's own address, unless it was opened via localhost.
  const joinAddress = (() => {
    const { hostname, port } = window.location;
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
    const host = isLocal ? (serverInfo?.lanAddresses[0] ?? hostname) : hostname;
    const path = import.meta.env.BASE_URL.replace(/\/$/, '');
    return (port && port !== '80' && port !== '443' ? `${host}:${port}` : host) + path;
  })();

  const active = players.filter(p => (p.status ?? 'active') === 'active');
  const online = active.filter(p => p.connected).length;
  const phase = gameState?.state ?? 'lobby';
  const inLevel = phase === 'intro' || phase === 'video' || phase === 'question' || phase === 'leaderboard';
  const theme = inLevel ? gameState?.levelConfig?.theme ?? 'marquee' : 'marquee';
  // The coordinator can put the round-by-round table up between questions.
  const shown = gameState?.showScoreboard && phase !== 'lobby' ? 'scoreboard' : phase;

  return (
    <div className="stage" data-theme={theme} style={{ height: '100vh', minHeight: 0 }}>
      <ComicBg slashes={theme === 'pop'} />

      <header style={{ display: 'flex', alignItems: 'center', gap: '1.4vw', padding: '1.8vh 2.4vw' }}>
        <div className="comic-panel" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '0.8vh 1.4vw 0.8vh 0.9vw', boxShadow: '4px 4px 0 var(--t-ink)' }}>
          <VyuhamLogo height="5.2vh" />
          <span className="comic-text" style={{ fontSize: 'clamp(1.2rem, 2vw, 2.2rem)', lineHeight: 1 }}>Movie Quiz</span>
          <span className="eyebrow" style={{ fontSize: '0.75rem', color: '#555' }}>Vyuham '26</span>
        </div>
        <span style={{ flex: 1 }} />
        {inLevel && gameState?.levelConfig && (
          <span className="comic-badge light" style={{ fontSize: 'clamp(0.9rem, 1.3vw, 1.4rem)' }}>
            Round {gameState.currentLevel}/{gameState.totalLevels} · {gameState.levelConfig.name}
          </span>
        )}
        <span className="comic-badge" style={{ fontSize: 'clamp(0.9rem, 1.3vw, 1.4rem)' }}>{PHASE_LABEL[phase]}</span>
        <span className="comic-badge light" style={{ fontSize: 'clamp(0.9rem, 1.3vw, 1.4rem)' }}>
          <span className={`dot ${isConnected ? 'dot-live' : 'dot-off'}`} />
          <span className="tabular">{online}</span> online
        </span>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        {!gameState && (
          <Centered>
            <Burst style={{ padding: '6vh 7vw' }}>
              <h1 className="comic-title" style={{ fontSize: '9vh' }}>{isConnected ? 'Get ready!' : 'Connecting…'}</h1>
            </Burst>
          </Centered>
        )}

        {shown === 'lobby' && gameState && <Lobby joinAddress={joinAddress} players={active} />}
        {shown === 'intro' && <Intro gameState={gameState} />}
        {shown === 'video' && gameState.video && (String(gameState.video.mime).startsWith('audio/') ? (
          <Centered style={{ gap: '5vh' }}>
            <Burst style={{ padding: '9vh 9vw 10vh' }}>
              <h1 className="comic-title slam" style={{ fontSize: 'clamp(4rem, 10vw, 12rem)' }}>🎵 Listen!</h1>
            </Burst>
            <div className="comic-panel" style={{ width: 'min(70vw, 900px)', padding: '2vh 2vw' }}>
              <QuestionVideo key={gameState.video.url} audio src={gameState.video.url} maxHeight="100%" command={videoCommand} onStatus={status => socket.emit('video_status', status)} />
            </div>
          </Centered>
        ) : (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', justifyContent: 'center', padding: '1vh 3vw 3.5vh' }}>
            <QuestionVideo key={gameState.video.url} src={gameState.video.url} maxHeight="100%" command={videoCommand} onStatus={status => socket.emit('video_status', status)}
              style={{ width: 'auto', height: '100%', maxWidth: '100%', margin: 0, border: '3px solid var(--t-ink)', boxShadow: '6px 6px 0 var(--t-ink)' }} />
          </div>
        ))}
        {shown === 'question' && (
          <Question gameState={gameState} timeLeft={timeLeft} maxTime={maxTime} answerCount={answerCount} players={active} />
        )}
        {shown === 'leaderboard' && <Reveal result={questionResult} players={active} hideStandings={!!gameState.standingsHidden} round={gameState.currentLevel} startedAt={gameState.questionStartTime} />}
        {shown === 'scoreboard' && <Scoreboard players={(gameState.finalLeaderboard || players).filter((p: any) => p.status === 'active')} columns={gameState.scoreColumns} />}
        {shown === 'podium' && gameState.manualFinish && <ManualFinish finalists={active} />}
        {shown === 'podium' && !gameState.manualFinish && <Podium board={(gameState.finalLeaderboard || players).filter((p: any) => p.status !== 'disqualified')} />}
      </div>
    </div>
  );
}

function Centered({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', position: 'relative', ...style }}>
      {children}
    </div>
  );
}

// ─── Lobby ────────────────────────────────────────────────────────────────────
function Lobby({ joinAddress, players }: { joinAddress: string; players: any[] }) {
  // Smaller chips as the room fills up, so 80+ players still fit.
  const chipSize = players.length > 60 ? 'sm' : players.length > 24 ? 'md' : 'lg';
  const avatar = chipSize === 'sm' ? 22 : chipSize === 'md' ? 30 : 40;
  return (
    <>
      <section style={{ flex: '1.1', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', padding: '0 3vw 4vh 4vw', gap: '4vh' }}>
        <Rise>
          <Burst style={{ padding: '7vh 6vw 8vh' }}>
            <div style={{ textAlign: 'center' }}>
              <h1 className="comic-title slam" style={{ fontSize: 'clamp(4rem, 9vw, 11rem)' }}>Movie<br />Quiz</h1>
            </div>
          </Burst>
        </Rise>

        <Rise d={260} className="comic-panel window" style={{ display: 'flex', alignItems: 'center', gap: '2vw', padding: '2.4vh 2.4vw' }}>
          <QrCode value={`${window.location.protocol}//${joinAddress}`} size="22vh" />
          <div>
            <div className="comic-text" style={{ fontSize: 'clamp(1.1rem, 1.6vw, 1.8rem)', marginBottom: '1vh' }}>Scan to play!</div>
            <span className="mono" style={{ fontSize: 'clamp(1.2rem, 2.2vw, 2.8rem)', fontWeight: 600, letterSpacing: '-0.02em' }}>{joinAddress}</span>
            <div className="dim" style={{ fontSize: 'clamp(0.85rem, 1.1vw, 1.15rem)', marginTop: '1.4vh', color: '#444' }}>
              Enter the ticket ID on your pass · pick your character
            </div>
          </div>
        </Rise>
      </section>

      <section style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '3vh 3.5vw 4vh 1vw', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: '2.4vh' }}>
          <span className="comic-title tabular" style={{ fontSize: 'clamp(5rem, 10vw, 10rem)' }}>{players.length}</span>
          <span className="comic-text" style={{ fontSize: 'clamp(1.6rem, 2.6vw, 3rem)' }}>{players.length === 1 ? 'player in!' : 'players in!'}</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: chipSize === 'sm' ? 6 : 10 }}>
          {players.length === 0 && <p className="comic-text" style={{ fontSize: '1.6rem' }}>Waiting for the first challenger…</p>}
          {[...players].reverse().map(p => (
            <span key={p.id} className="pop" style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: chipSize === 'sm' ? '3px 10px 3px 3px' : '4px 14px 4px 4px',
              background: '#fff', color: '#111', border: '2px solid var(--t-ink)', borderRadius: 999, boxShadow: '2px 2px 0 var(--t-ink)',
              fontWeight: 700, fontSize: chipSize === 'sm' ? '0.8rem' : chipSize === 'md' ? '0.95rem' : '1.1rem', opacity: p.connected ? 1 : 0.45,
            }}>
              <Avatar id={p.avatar} size={avatar} />
              {p.name}
            </span>
          ))}
        </div>
      </section>
    </>
  );
}

// ─── Level intro ──────────────────────────────────────────────────────────────
function Intro({ gameState }: { gameState: any }) {
  const config = gameState.levelConfig || {};
  return (
    <Centered style={{ gap: '3vh' }}>
      <Rise><span className="comic-badge light" style={{ fontSize: 'clamp(1.2rem, 2vw, 2.2rem)' }}>Round {gameState.currentLevel} of {gameState.totalLevels}</span></Rise>
      <Burst style={{ padding: '9vh 9vw 10vh' }}>
        <h1 className="comic-title slam" style={{ fontSize: 'clamp(4rem, 10vw, 12rem)', maxWidth: '62vw', textAlign: 'center' }}>{config.name}</h1>
      </Burst>
      <Rise d={450} style={{ display: 'flex', gap: '1.4vw', flexWrap: 'wrap', justifyContent: 'center' }}>
        {ROUND_LABEL[config.mode] && <span className="comic-badge" style={{ fontSize: 'clamp(1.1rem, 1.8vw, 2rem)' }}>{ROUND_LABEL[config.mode]}</span>}
        {gameState.rules?.multiplier !== false && <span className="comic-badge" style={{ fontSize: 'clamp(1.1rem, 1.8vw, 2rem)' }}>× {config.multiplier} points</span>}
        {config.cut && (
          <span className="comic-badge light" style={{ fontSize: 'clamp(1.1rem, 1.8vw, 2rem)' }}>✂ {config.cut.label}</span>
        )}
        {gameState.rules?.roundReset && <span className="comic-badge light" style={{ fontSize: 'clamp(1.1rem, 1.8vw, 2rem)' }}>Everyone starts this round at 0</span>}
        <span className="comic-badge light" style={{ fontSize: 'clamp(1.1rem, 1.8vw, 2rem)' }}>{gameState.playersLeft} players</span>
      </Rise>
      {roundRule(config) && <Rise d={600} as="p" className="comic-text" style={{ margin: 0, fontSize: 'clamp(1.1rem, 1.8vw, 2rem)' }}>{roundRule(config)}</Rise>}
    </Centered>
  );
}

// ─── Question ─────────────────────────────────────────────────────────────────
// Shrinks the text until it fits the space it has, so a long question never pushes the options
// off the projector. Anything sized in em inside it, like code, shrinks with it.
function FitText({ fitKey, children, style }: { fitKey: unknown; children: ReactNode; style: CSSProperties }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const outer = box.current;
    const text = inner.current;
    if (!outer || !text) return;
    const tooBig = () => text.offsetHeight > outer.clientHeight
      || [...text.querySelectorAll('pre')].some(pre => pre.scrollWidth > pre.clientWidth);
    const fit = () => {
      let scale = 1;
      text.style.setProperty('--fit', '1');
      while (scale > 0.2 && tooBig()) {
        scale -= 0.04;
        text.style.setProperty('--fit', String(scale));
      }
    };
    fit();
    document.fonts?.ready.then(fit);
    const watcher = new ResizeObserver(fit);
    watcher.observe(outer);
    return () => watcher.disconnect();
  }, [fitKey]);

  return (
    <div ref={box} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', padding: '6px 10px 10px 6px' }}>
      <h2 ref={inner} key={String(fitKey)} className="comic-panel window rise" style={{ margin: 'auto', fontWeight: 700, lineHeight: 1.16, letterSpacing: '-0.01em', ...style }}>
        {children}
      </h2>
    </div>
  );
}

const longest = (texts: string[] = []) => Math.max(0, ...texts.map(t => t.length));

// Buzzer and passing rounds: who has the question right now.
function TurnPanel({ live, spoken }: { live: any; spoken: boolean }) {
  const buzzer = live.mode === 'buzzer';
  const title = !live.holder ? 'Buzzers open!' : buzzer ? `${live.holder.name} buzzed!` : `${live.holder.name}'s turn`;
  const detail = !live.holder ? (live.out.length ? `${live.out.length} locked out — who's next?` : 'First to buzz answers')
    : spoken ? 'Say your answer!' : buzzer ? 'Answering on their phone' : live.tries ? 'Passed on — half points' : 'Answer or pass';
  return (
    <div key={live.holder?.id ?? 'open'} className="comic-panel pop" style={{ flex: 1, maxWidth: 820, minWidth: 0, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1vw', padding: '1.2vh 1.2vw', boxShadow: '4px 4px 0 var(--t-ink)' }}>
      {live.holder && <Avatar id={live.holder.avatar} size="7.5vh" />}
      <div style={{ minWidth: 0 }}>
        <div className="comic-text" style={{ fontSize: title.length > 24 ? 'clamp(1.1rem, 1.8vw, 2.1rem)' : 'clamp(1.4rem, 2.4vw, 2.8rem)', lineHeight: 1.05, overflowWrap: 'anywhere' }}>{title}</div>
        <div className="comic-text" style={{ fontSize: 'clamp(0.9rem, 1.2vw, 1.3rem)', color: '#555' }}>{detail}</div>
      </div>
    </div>
  );
}

function Question({ gameState, timeLeft, maxTime, answerCount, players }: {
  gameState: any; timeLeft: number; maxTime: number; answerCount: { answered: number; total: number }; players: any[];
}) {
  const q = gameState.currentQuestion;
  const pct = answerCount.total ? (answerCount.answered / answerCount.total) * 100 : 0;
  const withImage = !!q?.imageUrl;
  const widest = longest(q?.options);
  const optionSize = widest > 70 ? 'clamp(0.95rem, 1.3vw, 1.6rem)' : widest > 34 ? 'clamp(1.1rem, 1.6vw, 2rem)' : 'clamp(1.3rem, 2vw, 2.4rem)';

  // A picture sits left of the question; the options stay full width below, as on every question.
  const options = (
    <div style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.6vh 1.4vw' }}>
      {q?.options?.map((opt: string, idx: number) => (
        <div key={idx} data-opt={idx} className="opt-tile pop" style={{
          ['--d' as string]: `${200 + idx * 90}ms`, display: 'flex', alignItems: 'stretch', minHeight: '11vh', minWidth: 0, overflow: 'hidden',
        }}>
          <span className="comic-text" style={{
            width: '5.2vw', minWidth: 64, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '3px solid var(--t-ink)',
            background: 'var(--opt)', color: 'var(--on-opt)', fontSize: 'clamp(2.2rem, 3.2vw, 3.8rem)',
          }}>{OPTION_LABELS[idx]}</span>
          <span style={{ display: 'flex', alignItems: 'center', minWidth: 0, padding: '0.6vh 1.6vw', fontSize: optionSize, fontWeight: 700, lineHeight: 1.2, color: '#111', overflowWrap: 'anywhere' }}>{opt}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 3vw 3.5vh', minWidth: 0, minHeight: 0, gap: '2.4vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '2vw' }}>
        <span className="comic-badge light" style={{ fontSize: 'clamp(1.3rem, 2.2vw, 2.6rem)' }}>
          Q{gameState.currentQuestionIndex + 1}<span style={{ opacity: 0.5 }}>/{gameState.totalQuestions}</span>
        </span>
        {gameState.suddenDeath && <span className="comic-badge" style={{ fontSize: 'clamp(1rem, 1.6vw, 1.8rem)' }}>⚡ Sudden death</span>}
        {gameState.live ? <TurnPanel live={gameState.live} spoken={!!q?.spoken} /> : gameState.manual ? <span style={{ flex: 1 }} /> : (
          <div className="comic-panel" style={{ flex: 1, maxWidth: 460, marginLeft: 'auto', padding: '1.2vh 1.2vw', boxShadow: '4px 4px 0 var(--t-ink)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="comic-text" style={{ fontSize: '1rem' }}>Answers in</span>
              <span className="comic-text tabular" style={{ fontSize: '1.2rem' }}>{answerCount.answered} / {answerCount.total}</span>
            </div>
            <div className="meter" style={{ height: 10, border: '2px solid var(--t-ink)', background: '#fff' }}><span style={{ width: `${pct}%`, background: 'var(--t-accent)' }} /></div>
          </div>
        )}
        {gameState.questionEndsAt && <div className="timer-disc"><TimerRing value={timeLeft} max={maxTime} size={120} stroke={7} /></div>}
      </div>

      {/* Live score in buzzer and turns rounds, for the small field they are played with. */}
      {gameState.live && !gameState.suddenDeath && !gameState.byHand && players.length <= 8 && (
        <div style={{ display: 'flex', gap: '1vw', flexWrap: 'wrap', justifyContent: 'center' }}>
          {players.map(p => (
            <span key={p.id} className="comic-badge light" style={{ fontSize: 'clamp(0.9rem, 1.3vw, 1.5rem)', textTransform: 'none', paddingLeft: 6 }}>
              <Avatar id={p.avatar} size={30} />{p.name} · <span className="tabular">{p.score}</span>
            </span>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: '2.4vw' }}>
        {withImage && (
          <div className="pop" style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <QuestionPicture path={q.imageUrl} maxHeight="100%" style={{ width: '100%', height: '100%', margin: 0, background: '#fff', border: '3px solid var(--t-ink)', boxShadow: '6px 6px 0 var(--t-ink)' }} />
          </div>
        )}
        {q?.text ? (
          <FitText fitKey={q?.id} style={{
            maxWidth: 1500, padding: withImage ? '2.2vh 1.8vw' : '3.4vh 3vw', textAlign: withImage ? 'left' : 'center', textWrap: 'balance',
            fontSize: `calc(var(--fit, 1) * ${withImage ? 'clamp(1.6rem, 2.6vw, 3.2rem)' : 'clamp(2rem, 3.6vw, 4.4rem)'})`,
          }}>
            <QuestionText text={q.text} />
          </FitText>
        ) : !withImage && (
          // Audio or video with no text: the clip was the question.
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Burst style={{ padding: '6vh 7vw' }}><h2 className="comic-title" style={{ fontSize: 'clamp(3rem, 6vw, 7rem)' }}>{q?.spoken ? 'Name it!' : 'Pick your answer!'}</h2></Burst>
          </div>
        )}
      </div>
      {q?.options?.length > 0 && options}
    </div>
  );
}

// ─── Reveal: the answer, how people voted, and everyone's standing ────────────
function Reveal({ result, players, hideStandings, round, startedAt }: { result: any; players: any[]; hideStandings: boolean; round: number; startedAt: number | null }) {
  const stats: [string, number][] = result ? Object.entries(result.stats || {}) as [string, number][] : [];
  const maxCount = Math.max(1, ...stats.map(([, n]) => n));
  const totalAnswers = stats.reduce((sum, [, n]) => sum + n, 0);
  // Everyone still in, with their previous rank and score so rows climb to their new place.
  const everyone: any[] = result?.leaderboard || players;
  // Round 1 has the biggest field: the projector shows the top 10, phones show each player's own rank.
  const board = round === 1 ? everyone.slice(0, 10) : everyone;
  const cut = result?.elimination;
  const pending = result?.pendingCut;
  const roundEnd = result?.roundEnd;
  // Before this level's cut, show who is below the line; once it is confirmed, only survivors remain.
  const atRisk: string[] = cut ? [] : result?.atRisk ?? [];
  const cancelled = !!result?.cancelled;
  const roundBanner = (title: string, detail?: string) => (
    <Rise className="comic-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2vw', padding: '1.2vh 2vw', background: 'var(--t-accent)' }}>
      <span className="comic-title" style={{ fontSize: 'clamp(1.6rem, 2.8vw, 3.2rem)', color: '#fff' }}>{title}</span>
      {detail && <span className="comic-text" style={{ fontSize: 'clamp(1.2rem, 2vw, 2.2rem)', color: 'var(--t-on-accent, #fff)' }}>{detail}</span>}
    </Rise>
  );

  // Results kept by hand: just the answer. The quiz master has the scores.
  if (result?.byHand) {
    return (
      <Centered style={{ gap: '3vh', padding: '0 4vw 4vh' }}>
        <Burst style={{ padding: '7vh 7vw 8vh', maxWidth: '84vw' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="comic-text" style={{ fontSize: 'clamp(1rem, 1.6vw, 1.8rem)', color: '#333' }}>{cancelled ? 'This question' : 'The answer'}</div>
            <div className="comic-title slam" style={{ fontSize: 'clamp(2.6rem, 6vw, 7rem)', overflowWrap: 'anywhere' }}>{cancelled ? 'Cancelled' : result.correctAnswer}</div>
          </div>
        </Burst>
        {result.note && <Rise d={300} className="comic-panel" style={{ maxWidth: 1200, padding: '1.6vh 2vw', fontWeight: 600, fontSize: 'clamp(1.1rem, 1.8vw, 2.1rem)', lineHeight: 1.3 }}>{result.note}</Rise>}
      </Centered>
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '0 2.4vw 2.6vh', gap: '2vh' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: '1.6vw' }}>
        {result?.hasImage && !cancelled && (
          <div className="pop" style={{ width: '14vh', height: '14vh', flexShrink: 0 }}>
            <QuestionPicture path={`/live-image/${result.questionIndex}?t=${startedAt ?? 0}`} maxHeight="100%" style={{ width: '100%', height: '100%', background: '#fff', border: '3px solid var(--t-ink)', boxShadow: '4px 4px 0 var(--t-ink)' }} />
          </div>
        )}
        <Burst style={{ padding: '2.6vh 3.4vw', flexShrink: 0, maxWidth: '40vw' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="comic-text" style={{ fontSize: 'clamp(0.9rem, 1.2vw, 1.3rem)', color: '#333' }}>{cancelled ? 'This question' : 'The answer'}</div>
            <div className="comic-title" style={{ fontSize: 'clamp(1.8rem, 3.6vw, 4.2rem)', color: cancelled ? '#9ca3af' : '#22c55e', overflowWrap: 'anywhere' }}>{cancelled ? 'Cancelled' : result?.correctAnswer ?? '—'}</div>
            {cancelled && <div className="comic-text" style={{ fontSize: 'clamp(0.85rem, 1.1vw, 1.2rem)', color: '#333', marginTop: 6 }}>No points, and no one is affected.</div>}
          </div>
        </Burst>

        {(stats.length > 0 || result?.note) && <div className="comic-panel" style={{ flex: 1, minWidth: 0, padding: '1.4vh 1.4vw', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '0.9vh' }}>
          {result?.note && <div style={{ fontWeight: 600, fontSize: 'clamp(0.95rem, 1.25vw, 1.5rem)', lineHeight: 1.3, overflowWrap: 'anywhere' }}>{result.note}</div>}
          {stats.map(([option, count], idx) => {
            const correct = option === result.correctAnswer;
            return (
              <div key={option} data-opt={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: correct ? 1 : 0.5 }}>
                <span className="comic-text" style={{ width: 34, height: 34, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--opt)', border: '2px solid #111', borderRadius: 8, fontSize: '1.2rem' }}>
                  {correct ? '✓' : OPTION_LABELS[idx]}
                </span>
                <span style={{ width: '24%', minWidth: 0, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option}</span>
                <div style={{ flex: 1, height: 14, background: '#eee', border: '2px solid #111', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${(count / maxCount) * 100}%`, height: '100%', background: 'var(--opt)', transformOrigin: 'left', animation: `grow-x 0.9s var(--ease-out) ${300 + idx * 100}ms backwards` }} />
                </div>
                <span className="comic-text tabular" style={{ width: 40, textAlign: 'right' }}>{count}</span>
              </div>
            );
          })}
        </div>}

        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '1vh', flexShrink: 0, marginLeft: 'auto' }}>
          {result?.mode === 'standard' && !cancelled && <span className="comic-badge light">{totalAnswers} answered</span>}
          {result?.mode === 'standard' && result?.speedStar && <span className="comic-badge">⚡ {result.speedStar}</span>}
          {result?.turns?.map((t: any) => (
            <span key={t.name} className={`comic-badge${t.outcome === 'correct' ? '' : ' light'}`}>
              {t.outcome === 'correct' ? '✓' : t.outcome === 'wrong' ? '✕' : '→'} {t.name}{t.points ? ` ${t.points > 0 ? '+' : ''}${t.points}` : ''}
            </span>
          ))}
          {result?.cutLabel && !cut && <span className="comic-badge light">✂ {result.cutLabel}</span>}
        </div>
      </div>

      {result?.suddenDeath && roundBanner('Sudden death!', result.suddenDeath.winner ? `${result.suddenDeath.winner} wins the tie-break` : 'No winner — the tie stands')}
      {pending && !cut && !result?.suddenDeath && roundBanner(`End of ${roundEnd?.levelName}!`, `The cut is coming… ${pending.label} · ${pending.out} below the line`)}
      {cut && roundBanner(`End of ${cut.levelName}!`, cut.eliminated.length > 0 ? `${cut.advanced} go through · ${cut.eliminated.length} eliminated` : 'Everyone goes through!')}
      {roundEnd && !pending && !cut && !roundEnd.isFinal && roundBanner(`End of ${roundEnd.levelName}!`, `On to round ${roundEnd.round + 1}!`)}

      {hideStandings ? (
        <Centered>
          <Burst style={{ padding: '5vh 6vw' }}>
            <h2 className="comic-title" style={{ fontSize: 'clamp(2.4rem, 5vw, 5.6rem)', textAlign: 'center' }}>Standings hidden</h2>
          </Burst>
          <p className="comic-text" style={{ fontSize: 'clamp(1.1rem, 1.8vw, 2rem)', marginTop: '3vh' }}>Who wins? Find out at the final results.</p>
        </Centered>
      ) : (
        <>
          {board.length < everyone.length && <span className="comic-badge light" style={{ alignSelf: 'flex-start' }}>Top {board.length} of {everyone.length}</span>}
          <div style={{ flex: 1, minHeight: 0 }}>
            <Standings players={board} atRisk={atRisk} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── End of a final run by hand: the game shows no ranks, the quiz master announces them ──
function ManualFinish({ finalists }: { finalists: any[] }) {
  return (
    <Centered style={{ gap: '4vh', padding: '0 4vw 4vh' }}>
      <Burst style={{ padding: '4vh 6vw 5vh' }}>
        <h1 className="comic-title slam" style={{ fontSize: 'clamp(3rem, 6vw, 7rem)' }}>That's a wrap!</h1>
      </Burst>
      <div style={{ display: 'flex', gap: '2vw', flexWrap: 'wrap', justifyContent: 'center' }}>
        {finalists.slice(0, 8).map(p => (
          <div key={p.id} className="comic-panel pop" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1vh', padding: '2vh 1.6vw' }}>
            <Avatar id={p.avatar} size="11vh" />
            <div className="comic-text" style={{ fontSize: 'clamp(1.1rem, 1.7vw, 2rem)', textAlign: 'center' }}>{p.name}</div>
          </div>
        ))}
      </div>
      <p className="comic-text" style={{ margin: 0, fontSize: 'clamp(1.3rem, 2.2vw, 2.6rem)' }}>The quiz master will announce the winners.</p>
    </Centered>
  );
}

// ─── Scoreboard: each round and the total, for the finalists ──────────────────
function Scoreboard({ players, columns }: { players: any[]; columns: string[] }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 4vw 3vh', gap: '3vh' }}>
      <Burst style={{ padding: '2.6vh 5vw 3.4vh' }}><h1 className="comic-title slam" style={{ fontSize: 'clamp(2.6rem, 5vw, 6rem)' }}>Scoreboard</h1></Burst>
      <div className="comic-panel" style={{ width: '100%', maxWidth: 1400, minHeight: 0, overflow: 'hidden' }}>
        <table className="scoreboard">
          <thead>
            <tr><th>#</th><th style={{ textAlign: 'left' }}>Player</th>{columns.map(c => <th key={c}>{c}</th>)}<th>Total</th></tr>
          </thead>
          <tbody>
            {players.slice(0, 12).map((p, i) => (
              <tr key={p.id}>
                <td>{i + 1}</td>
                <td className="sb-name"><Avatar id={p.avatar} size="4vh" />{p.name}</td>
                {columns.map(c => <td key={c}>{p.rounds?.[c] ?? 0}</td>)}
                <td className="sb-total">{p.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Podium ───────────────────────────────────────────────────────────────────
function Podium({ board }: { board: any[] }) {
  // Classic podium order: 2nd, 1st, 3rd
  const slots = [
    { p: board[1], place: 2, height: '22vh', delay: 500, color: '#e5e7eb' },
    { p: board[0], place: 1, height: '32vh', delay: 900, color: 'var(--t-title)' },
    { p: board[2], place: 3, height: '15vh', delay: 200, color: '#fdba74' },
  ];
  const rest = board.slice(3, 10);

  // Confetti from both sides, starting as the champion appears on the podium.
  useEffect(() => {
    const colors = ['#3da9fc', '#ff5c8a', '#ffc531', '#3ddc97'];
    const burst = () => {
      confetti({ particleCount: 90, angle: 60, spread: 70, origin: { x: 0, y: 0.75 }, colors });
      confetti({ particleCount: 90, angle: 120, spread: 70, origin: { x: 1, y: 0.75 }, colors });
    };
    const timers = [1400, 2400, 3400, 4600, 6000].map(ms => setTimeout(burst, ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', padding: '0 4vw' }}>
      <Burst style={{ padding: '2.6vh 5vw 3.4vh', marginBottom: '3vh' }}>
        <h1 className="comic-title slam" style={{ fontSize: 'clamp(3rem, 6vw, 7rem)' }}>Champions!</h1>
      </Burst>

      <div style={{ flex: 1, width: '100%', maxWidth: 1300, display: 'grid', gridTemplateColumns: '1fr 1.15fr 1fr', gap: '2vw', alignItems: 'end' }}>
        {slots.map(({ p, place, height, delay, color }) => (
          <div key={place} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
            {p && (
              <div className="pop" style={{ ['--d' as string]: `${delay + 500}ms`, display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '1.6vh', maxWidth: '100%' }}>
                <Avatar id={p.avatar} size={place === 1 ? '15vh' : '12vh'} style={{ border: '4px solid var(--t-ink)', boxShadow: '5px 5px 0 var(--t-ink)' }} />
                <div className="comic-text" style={{ marginTop: '1.2vh', fontSize: place === 1 ? 'clamp(2rem, 3.2vw, 3.6rem)' : 'clamp(1.4rem, 2.2vw, 2.6rem)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </div>
                <span className="comic-badge light" style={{ fontSize: '1.1rem', marginTop: 6 }}>{p.score} pts</span>
              </div>
            )}
            <div className="comic-panel" style={{
              width: '100%', height, background: color, borderRadius: '16px 16px 0 0', borderBottom: 0,
              display: 'flex', justifyContent: 'center', paddingTop: '1.6vh',
              transformOrigin: 'bottom', animation: `grow-y 0.9s var(--ease-out) ${delay}ms backwards`,
            }}>
              <span className="comic-title" style={{ fontSize: place === 1 ? '10vh' : '7vh' }}>{place}</span>
            </div>
          </div>
        ))}
      </div>

      {rest.length > 0 && (
        <Rise d={1600} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', padding: '2vh 0' }}>
          {rest.map((p: any, i: number) => (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 14px 4px 4px', background: '#fff', color: '#111', border: '2px solid var(--t-ink)', borderRadius: 999, boxShadow: '2px 2px 0 var(--t-ink)', fontWeight: 700 }}>
              <Avatar id={p.avatar} size={30} /> {i + 4}. {p.name} · {p.score}
            </span>
          ))}
        </Rise>
      )}
      <div style={{ position: 'absolute', right: '2vw', bottom: '2vh' }}><VyuhamLogo height="10vh" /></div>
    </div>
  );
}
