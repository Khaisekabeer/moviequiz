import React, { useCallback, useEffect, useState } from 'react';
import { api, API_BASE, ApiError, fetchObjectUrl } from '../../lib/api';
import { OPTION_LABELS, Panel } from '../../components/ui';
import QuestionText from '../../components/QuestionText';
import { checkSet, importColumns, IMPORT_TEMPLATE, parseQuestionImport } from '../../lib/questionTools';

interface Question {
  id: number; level: number; position: number; text: string; type: 'mcq' | 'tf' | 'short'; // short: spoken, the coordinator marks it
  accepted?: string;       // other answers the coordinator may allow on a spoken question
  options: string[]; correctAnswer: string; timeLimit: number; points: number; isActive: boolean;
  note?: string;           // optional, shown on phones and the projector after the reveal
  backup?: boolean;        // held back: the host plays it only in place of a cancelled question
  imageId?: string | null; // picture for "identify this person / object" questions (stored encrypted)
  videoId?: string | null; // video or audio clip played before the question (stored in the private video bucket)
  clipKind?: 'audio' | 'video' | null; // which of the two the clip is, from its file type
}
type Draft = Omit<Question, 'id' | 'position'> & { id?: number };

// Levels (rounds) are set up by the quiz master and played in this order.
interface Cut { rule: 'top' | 'percent' | 'min_score' | 'bottom' | 'min_correct'; value: number; ties: 'speed' | 'include' }
type RoundMode = 'standard' | 'buzzer' | 'passing' | 'display';
interface Scoring { correct: number; wrong: number; timeout: number }
interface Level {
  number: number; name: string; multiplier: number; theme: string | null; mode: RoundMode; cut: Cut | null; isActive: boolean;
  afterMiss: 'next' | 'close'; untimed: boolean; answerSeconds: number; resetScores: boolean; scoring: Scoring | null; manualResults: boolean;
}
// Round numbers count only the levels that are on, so switching one off closes the gap after it.
const roundOf = (levels: Level[], level: Level) => levels.filter(l => l.isActive && l.number <= level.number).length;

// Looks for the projector and phones during a level (see comic.css).
const THEMES: { id: string; label: string; swatch: string }[] = [
  { id: 'marquee', label: 'Marquee — midnight blue & gold lights', swatch: '#101a3a' },
  { id: 'curtain', label: 'Curtain — velvet red', swatch: '#7a0f1e' },
  { id: 'noir', label: 'Noir — black & white film', swatch: '#141414' },
  { id: 'popcorn', label: 'Popcorn — cream & red stripes', swatch: '#fff3d6' },
  { id: 'blast', label: 'Blast — yellow comic burst', swatch: '#ffc21a' },
  { id: 'pop', label: 'Pop — yellow & pink pop art', swatch: '#ff4fa8' },
  { id: 'arcade', label: 'Arcade — lime game burst', swatch: '#a6d91a' },
  { id: 'circuit', label: 'Circuit — blue tech windows', swatch: '#93b8ff' },
  { id: 'classic', label: 'Classic — plain white', swatch: '#ffffff' },
];

// How the questions of a level are played (see gameEngine.js).
const ROUND_MODES: { id: RoundMode; label: string }[] = [
  { id: 'standard', label: 'Standard — everyone answers' },
  { id: 'buzzer', label: 'Buzzer — first to buzz answers' },
  { id: 'passing', label: 'Turns — one player at a time, can pass' },
  { id: 'display', label: 'Show only — quiz master runs answers and scores' },
];

// These rounds have no options: the player says the answer and the coordinator marks it.
const spokenOnly = (levels: Level[], number: number) => ['buzzer', 'passing'].includes(levels.find(l => l.number === number)?.mode ?? '');

// What a question is made of. Only the text and media are stored; the format follows from them.
type Format = 'text' | 'image' | 'image_text' | 'audio' | 'video';
const FORMATS: { id: Format; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'image', label: 'Image only' },
  { id: 'image_text', label: 'Image + text' },
  { id: 'audio', label: 'Audio' },
  { id: 'video', label: 'Video' },
];
const formatOf = (q: { text: string; imageId?: string | null; videoId?: string | null; clipKind?: string | null }): Format => {
  if (q.videoId) return q.clipKind === 'audio' ? 'audio' : 'video';
  if (q.imageId) return q.text.trim() ? 'image_text' : 'image';
  return 'text';
};

// Who goes on to the next level when this one ends. The coordinator confirms every cut.
const CUT_RULES: { id: Cut['rule']; label: string; unit: string }[] = [
  { id: 'top', label: 'Top N go through', unit: 'players' },
  { id: 'percent', label: 'Top % go through', unit: '%' },
  { id: 'min_score', label: 'Minimum score to go through', unit: 'points' },
  { id: 'bottom', label: 'Bottom N are out', unit: 'players' },
  { id: 'min_correct', label: 'Minimum correct answers in this level', unit: 'correct' },
];

const blank = (level: number): Draft => ({
  level, text: '', type: 'mcq', options: ['', '', '', ''], correctAnswer: '', accepted: '', note: '', backup: false, timeLimit: 20, points: 1000, isActive: true, imageId: null, videoId: null,
});

interface SetSummary { id: string; name: string; ready: boolean; questions: number; active: number; levels: number }
interface OpenSet { id: string; name: string }

// Question sets ("Main set", "Trial set", ...): each has its own PIN, chosen by the quiz master.
// The coordinator enters that PIN in the host console to load the set into the game.
export default function Questions() {
  const [open, setOpen] = useState<{ until: number; bank: OpenSet } | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<{ code: string; setName: string } | null>(null);

  useEffect(() => {
    api('/auth/me')
      .then(r => { if (r.vaultUntil && r.vaultBank) setOpen({ until: r.vaultUntil, bank: r.vaultBank }); })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  // Re-lock in the UI when the server-side unlock expires.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => setOpen(null), Math.max(0, open.until - Date.now()));
    return () => clearTimeout(id);
  }, [open]);

  const opened = (r: { vaultUntil: number; bank: OpenSet; recoveryCode?: string }) => {
    setOpen({ until: r.vaultUntil, bank: r.bank });
    if (r.recoveryCode) setNotice({ code: r.recoveryCode, setName: r.bank.name });
  };

  if (!checked) return null;
  if (notice) return <RecoveryCodeNotice code={notice.code} setName={notice.setName} onDone={() => setNotice(null)} />;
  if (!open || open.until <= Date.now()) return <SetPicker onOpened={opened} />;
  return (
    <QuestionBank key={open.bank.id} bank={open.bank} vaultUntil={open.until} onLocked={() => setOpen(null)}
      onRenamed={name => setOpen({ ...open, bank: { ...open.bank, name } })}
      onRecoveryCode={code => setNotice({ code, setName: open.bank.name })} />
  );
}

// ─── Pick a set and open it with its PIN; create a set; first-time setup ──────
type SetMode = { kind: 'open' | 'setup' | 'recover'; set: SetSummary } | { kind: 'create' } | null;

const pinField = (value: string, onChange: (v: string) => void, label: string, id: string, autoFocus = false) => (
  <div className="form-row">
    <label className="eyebrow" htmlFor={id}>{label}</label>
    <input id={id} className="field" type="password" inputMode="numeric" autoComplete="off" value={value} autoFocus={autoFocus}
      onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 12))}
      style={{ fontFamily: 'var(--font-mono)', fontSize: '1.3rem', letterSpacing: '0.4em', textAlign: 'center' }} />
  </div>
);

function SetPicker({ onOpened }: { onOpened: (r: { vaultUntil: number; bank: OpenSet; recoveryCode?: string }) => void }) {
  const [sets, setSets] = useState<SetSummary[] | null>(null);
  const [mode, setMode] = useState<SetMode>(null);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [oldPin, setOldPin] = useState('');
  const [code, setCode] = useState('');
  const [useOldCode, setUseOldCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<SetSummary[]>('/banks').then(setSets).catch(err => setError(err.message)); }, []);

  const choose = (m: SetMode) => { setMode(m); setPin(''); setPin2(''); setOldPin(''); setCode(''); setName(''); setError(''); setUseOldCode(false); };
  const needsNewPin = mode && mode.kind !== 'open';
  const pinsOk = pin.length >= 4 && (!needsNewPin || pin === pin2);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mode) return;
    setBusy(true);
    setError('');
    try {
      const r = mode.kind === 'create'
        ? await api('/banks', { method: 'POST', body: { name: name.trim(), pin } })
        : mode.kind === 'open'
          ? await api(`/banks/${mode.set.id}/open`, { method: 'POST', body: { pin } })
          : mode.kind === 'recover'
            ? await api(`/banks/${mode.set.id}/recover`, { method: 'POST', body: { recoveryCode: code, pin } })
            : await api(`/banks/${mode.set.id}/setup`, { method: 'POST', body: { pin, ...(useOldCode ? { oldRecoveryCode: code } : { oldPin }) } });
      onOpened(r);
    } catch (err) {
      setError((err as Error).message);
      setPin(mode.kind === 'open' ? '' : pin);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel bracketed className="panel-lg" style={{ maxWidth: 560, margin: '24px auto', padding: '30px 28px' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '2rem' }} aria-hidden="true">🔒</div>
        <div className="eyebrow" style={{ marginTop: 8 }}>Encrypted · each set has its own PIN</div>
        <h2 className="display" style={{ fontSize: '2.6rem', margin: '8px 0 8px' }}>Question sets</h2>
        <p className="dim" style={{ margin: '0 0 20px', fontSize: '0.88rem', lineHeight: 1.5 }}>
          Open a set with its PIN to edit it (30 minutes). Give the coordinator the PIN of the set to play — they enter it in the host console to load it.
        </p>
      </div>

      {!mode && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sets === null && !error && <p className="dim" style={{ textAlign: 'center' }}>Loading…</p>}
          {sets?.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{s.name}</div>
                <div className="dim" style={{ fontSize: '0.8rem' }}>{s.questions} questions · {s.levels} levels{s.ready ? '' : ' · needs a PIN'}</div>
              </div>
              {s.ready ? (
                <>
                  <button className="btn btn-ghost btn-sm" onClick={() => choose({ kind: 'recover', set: s })}>Forgot PIN</button>
                  <button className="btn btn-heat btn-sm" onClick={() => choose({ kind: 'open', set: s })}>Open</button>
                </>
              ) : (
                <button className="btn btn-heat btn-sm" onClick={() => choose({ kind: 'setup', set: s })}>Set up</button>
              )}
            </div>
          ))}
          <button className="btn btn-ghost" onClick={() => choose({ kind: 'create' })} disabled={(sets?.length ?? 0) >= 20}>+ New question set</button>
        </div>
      )}

      {mode && (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>
            {mode.kind === 'create' ? 'New question set'
              : mode.kind === 'open' ? `Open "${mode.set.name}"`
              : mode.kind === 'recover' ? `New PIN for "${mode.set.name}"`
              : `Set up "${mode.set.name}"`}
          </div>

          {mode.kind === 'create' && (
            <div className="form-row">
              <label className="eyebrow" htmlFor="set-name">Name</label>
              <input id="set-name" className="field" value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="e.g. Main set" autoFocus required />
            </div>
          )}

          {mode.kind === 'setup' && mode.set.questions > 0 && (
            <>
              <p className="dim" style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.5 }}>
                These {mode.set.questions} questions were encrypted before sets existed. Confirm once with your <strong>old quiz master PIN</strong>
                {' '}(the one you used to unlock the question bank) — or the old recovery code — to move them into this set.
              </p>
              {useOldCode ? (
                <div className="form-row">
                  <label className="eyebrow" htmlFor="old-code">Old recovery code</label>
                  <input id="old-code" className="field" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                    autoComplete="off" spellCheck={false} style={{ fontFamily: 'var(--font-mono)', textAlign: 'center' }} />
                </div>
              ) : pinField(oldPin, setOldPin, 'Old quiz master PIN', 'old-pin', true)}
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setUseOldCode(!useOldCode); setCode(''); setOldPin(''); }}>
                {useOldCode ? 'Use the old PIN instead' : 'Use the old recovery code instead'}
              </button>
            </>
          )}

          {mode.kind === 'recover' && (
            <div className="form-row">
              <label className="eyebrow" htmlFor="rec-code">This set's recovery code</label>
              <input id="rec-code" className="field" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                autoComplete="off" spellCheck={false} autoFocus style={{ fontFamily: 'var(--font-mono)', textAlign: 'center' }} />
            </div>
          )}

          {mode.kind === 'open'
            ? pinField(pin, setPin, 'Set PIN', 'set-pin', true)
            : (
              <>
                {pinField(pin, setPin, mode.kind === 'create' ? 'Choose the set PIN (4–12 digits)' : 'New set PIN (4–12 digits)', 'new-pin')}
                {pinField(pin2, setPin2, 'Type it again', 'new-pin2')}
                {pin2.length >= 4 && pin !== pin2 && <p className="error-text">The PINs don't match</p>}
              </>
            )}

          <button className="btn btn-heat btn-block" disabled={busy || !pinsOk || (mode.kind === 'create' && !name.trim())
            || (mode.kind === 'setup' && mode.set.questions > 0 && (useOldCode ? code.replace(/[^A-Z0-9]/g, '').length < 24 : oldPin.length < 4))
            || (mode.kind === 'recover' && code.replace(/[^A-Z0-9]/g, '').length < 24)}>
            {busy ? 'Checking…' : mode.kind === 'create' ? 'Create set' : mode.kind === 'open' ? 'Open' : mode.kind === 'recover' ? 'Set new PIN & open' : 'Set PIN & open'}
          </button>
          {error && <p role="alert" className="error-text">{error}</p>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => choose(null)} style={{ alignSelf: 'center' }}>← All sets</button>
        </form>
      )}
      {!mode && error && <p role="alert" className="error-text" style={{ marginTop: 12 }}>{error}</p>}
    </Panel>
  );
}

// Shown once: when a set is created or set up, and when its recovery code is replaced.
function RecoveryCodeNotice({ code, setName, onDone }: { code: string; setName: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <Panel bracketed className="panel-lg" style={{ maxWidth: 520, margin: '24px auto', padding: '34px 30px', textAlign: 'center' }}>
      <div className="eyebrow">Recovery code · {setName}</div>
      <h2 className="display" style={{ fontSize: '2.4rem', margin: '10px 0 10px' }}>Save this code</h2>
      <p className="dim" style={{ margin: '0 0 20px', fontSize: '0.92rem', lineHeight: 1.55 }}>
        If this set's PIN is forgotten, this code is the <strong>only</strong> way to set a new one.
        Write it down and keep it somewhere safe. It will not be shown again.
      </p>
      <div className="mono" style={{ fontSize: '1.25rem', fontWeight: 600, letterSpacing: '0.06em', padding: '18px 12px', border: '2px dashed var(--line-strong)', borderRadius: 'var(--radius)', userSelect: 'all', wordBreak: 'break-all' }}>
        {code}
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', margin: '20px 0 16px', fontSize: '0.9rem' }}>
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} style={{ width: 18, height: 18 }} />
        I have saved the recovery code
      </label>
      <button className="btn btn-heat btn-block" disabled={!saved} onClick={onDone}>Continue to the set</button>
    </Panel>
  );
}

// ─── Load into game (quiz master test load; the coordinator loads with the PIN) ──
function LoadIntoGame({ guard, refreshKey, bank }: { guard: <T>(fn: () => Promise<T>) => Promise<T | undefined>; refreshKey: number; bank: OpenSet }) {
  const [status, setStatus] = useState<{ online?: boolean; error?: string; state?: string; count?: number; by?: string; bank?: OpenSet | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(() => { api('/game/questions-status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const load = async () => {
    setBusy(true);
    setMessage('');
    const r = await guard(() => api('/game/load-questions', { method: 'POST', body: { bankId: bank.id } }));
    if (r) setMessage(`✓ ${r.count} questions from "${bank.name}" loaded into the game.`);
    setBusy(false);
    refresh();
  };

  const offline = status?.online === false;
  const inLobby = !status || offline || status.state === 'lobby';
  return (
    <Panel bracketed style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 300px' }}>
        <div className="eyebrow">Live event {offline ? <span className="pill pill-bad" style={{ marginLeft: 8 }}>Game server offline</span> : null}</div>
        <div style={{ fontWeight: 600, marginTop: 8 }}>
          {offline
            ? 'The event-day game server is not reachable'
            : status?.count ? `"${status.bank?.name ?? 'A set'}" is loaded in the game — ${status.count} questions${status.by ? `, by ${status.by}` : ''}` : 'No set loaded in the game yet'}
        </div>
        <p className="dim" style={{ fontSize: '0.82rem', margin: '6px 0 0', lineHeight: 1.5 }}>
          {offline
            ? 'On event day, start it on the laptop (npm run game + Cloudflare Tunnel); an admin checks the address in Admin → Overview. You can keep editing meanwhile.'
            : inLobby
              ? 'On event day the coordinator loads the set from the host console by entering its PIN. You can also load this set from here to test it.'
              : 'The game is running — a set can be loaded again once it is reset to the lobby.'}
        </p>
        {message && <p role="status" style={{ margin: '8px 0 0', fontSize: '0.88rem', color: 'var(--good)' }}>{message}</p>}
      </div>
      <button className="btn btn-heat" onClick={load} disabled={busy || !inLobby || offline}>
        {busy ? 'Loading…' : `Load "${bank.name}" →`}
      </button>
    </Panel>
  );
}

// ─── Bank ─────────────────────────────────────────────────────────────────────
function QuestionBank({ bank, vaultUntil, onLocked, onRenamed, onRecoveryCode }: {
  bank: OpenSet; vaultUntil: number; onLocked: () => void; onRenamed: (name: string) => void; onRecoveryCode: (code: string) => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [timer, setTimer] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Any 423 means the server locked the bank (timeout) — go back to the PIN screen.
  const guard = useCallback(async <T,>(fn: () => Promise<T>) => {
    setError('');
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) onLocked();
      else setError((err as Error).message);
      return undefined;
    }
  }, [onLocked]);

  const load = useCallback(() => guard(async () => {
    const [qs, ls] = await Promise.all([api<Question[]>('/questions'), api<Level[]>('/levels')]);
    setQuestions(qs);
    setLevels(ls);
    setLevel(current => (ls.some(l => l.number === current) ? current : ls[0]?.number ?? 1));
  }), [guard]);
  useEffect(() => { load(); }, [load]);

  const inLevel = questions.filter(q => q.level === level);
  const current = levels.find(l => l.number === level);
  const round = current ? roundOf(levels, current) : 0;
  const addLevel = () => guard(async () => {
    const created = await api<Level>('/levels', { method: 'POST', body: { name: `Level ${levels.length + 1}`, multiplier: 1 } });
    await load();
    setLevel(created.number);
    setDraft(null);
  });
  const lock = async () => { await api('/auth/vault/lock', { method: 'POST' }).catch(() => {}); onLocked(); };
  const newRecoveryCode = () => {
    if (!confirm('Create a new recovery code? The old code will stop working.')) return;
    guard(async () => onRecoveryCode((await api('/questions/recovery-code', { method: 'POST' })).recoveryCode));
  };
  const left = Math.max(0, Math.round((vaultUntil - now) / 1000));
  // Set actions: rename, change PIN (tell the coordinator), delete.
  const rename = () => {
    const name = prompt('New name for this set', bank.name)?.trim();
    if (name && name !== bank.name) guard(async () => { await api('/banks/current', { method: 'PATCH', body: { name } }); onRenamed(name); });
  };
  const changePin = () => {
    const currentPin = prompt(`Current PIN of "${bank.name}"`);
    if (!currentPin) return;
    const pin = prompt('New PIN (4-12 digits). Tell the coordinator the new PIN.');
    if (!pin) return;
    if (prompt('Type the new PIN again') !== pin) { alert("The PINs don't match — nothing changed."); return; }
    guard(async () => { await api(`/banks/${bank.id}/pin`, { method: 'POST', body: { currentPin, pin } }); alert('PIN changed.'); });
  };
  const deleteSet = () => {
    const confirmName = prompt(`Delete "${bank.name}" with all its levels and ${questions.length} questions? This cannot be undone.

Type the set name to confirm:`);
    if (confirmName === null) return;
    guard(async () => { await api('/banks/current', { method: 'DELETE', body: { confirmName } }); onLocked(); });
  };

  const move = (q: Question, direction: 'up' | 'down') =>
    guard(async () => { await api(`/questions/${q.id}/move`, { method: 'POST', body: { direction } }); await load(); });
  const remove = (q: Question) => {
    if (!confirm(`Delete this question?\n\n${q.text}`)) return;
    guard(async () => { await api(`/questions/${q.id}`, { method: 'DELETE' }); await load(); });
  };
  const applyTimer = (e: React.FormEvent) => {
    e.preventDefault();
    const seconds = Number(timer);
    if (!confirm(`Set every "${current?.name}" question to ${seconds} seconds?`)) return;
    guard(async () => { await api(`/levels/${level}/timer`, { method: 'PUT', body: { seconds } }); setTimer(''); await load(); });
  };

  return (
    <>
      <Panel style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="pill pill-good">🔓 {bank.name}</span>
        <span className="dim" style={{ fontSize: '0.88rem' }}>Re-locks in <span className="mono">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span></span>
        <span style={{ flex: 1 }} />
        <span className="dim" style={{ fontSize: '0.85rem' }}>{questions.filter(q => q.isActive).length} active of {questions.length} questions</span>
        <button className="btn btn-ghost btn-sm" onClick={rename}>Rename</button>
        <button className="btn btn-ghost btn-sm" onClick={changePin}>Change PIN</button>
        <button className="btn btn-ghost btn-sm" onClick={newRecoveryCode}>New recovery code</button>
        <button className="btn btn-danger btn-sm" onClick={deleteSet}>Delete set</button>
        <button className="btn btn-heat btn-sm" onClick={lock}>Lock · switch set</button>
      </Panel>

      <LoadIntoGame guard={guard} refreshKey={questions.length} bank={bank} />

      <SetTools questions={questions} levels={levels} guard={guard} reload={load} />
      <AnswerSheet questions={questions} levels={levels} bankName={bank.name} />

      <nav className="tabs" aria-label="Levels">
        {levels.map(l => (
          <button key={l.number} className={`tab${level === l.number ? ' active' : ''}`} style={{ opacity: l.isActive ? 1 : 0.55 }} onClick={() => { setLevel(l.number); setDraft(null); }}>
            {l.isActive ? `L${roundOf(levels, l)}` : 'Off'} · {l.name}<span className="count">{questions.filter(q => q.level === l.number).length}</span>
          </button>
        ))}
        <button className="tab" onClick={addLevel} disabled={levels.length >= 20}>+ Add level</button>
      </nav>

      {current && (
        <LevelSettings key={current.number} level={current} round={round} questionCount={inLevel.length} guard={guard}
          onChanged={load} />
      )}

      <div className="grid-2" style={{ alignItems: 'end' }}>
        <Panel>
          <div className="eyebrow">Timer for every question in this level</div>
          <form onSubmit={applyTimer} style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <input className="field field-sm" type="number" min={5} max={300} placeholder="Seconds" value={timer}
              onChange={e => setTimer(e.target.value)} style={{ maxWidth: 140 }} aria-label={`Seconds for every ${current?.name} question`} />
            <button className="btn btn-ghost btn-sm" disabled={!timer || Number(timer) < 5 || Number(timer) > 300}>Apply to all in level</button>
          </form>
          <p className="dim" style={{ fontSize: '0.8rem', margin: '10px 0 0' }}>Or set a timer per question when editing it. Points ×{current?.multiplier ?? 1} in this level.</p>
        </Panel>
        <div style={{ textAlign: 'right' }}>
          <button className="btn btn-heat" onClick={() => setDraft(blank(level))} disabled={(!!draft && !draft.id) || !current}>+ Add question to {current?.name ?? 'this level'}</button>
        </div>
      </div>

      {error && <p role="alert" className="error-text" style={{ textAlign: 'left' }}>{error}</p>}

      {draft && !draft.id && (
        <Editor draft={draft} levels={levels} onCancel={() => setDraft(null)}
          onSave={d => guard(async () => { await api('/questions', { method: 'POST', body: d }); setDraft(null); await load(); })} />
      )}

      {inLevel.length === 0 && !draft && (
        <Panel style={{ textAlign: 'center', padding: '36px 20px' }}>
          <p className="dim" style={{ margin: 0 }}>No questions in this level yet.</p>
        </Panel>
      )}

      {inLevel.map((q, i) => (
        draft?.id === q.id ? (
          <Editor key={q.id} draft={draft} levels={levels} onCancel={() => setDraft(null)}
            onSave={d => guard(async () => { await api(`/questions/${q.id}`, { method: 'PUT', body: d }); setDraft(null); await load(); })} />
        ) : (
          <Panel key={q.id} style={{ opacity: q.isActive ? 1 : 0.55 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <span className="display faint" style={{ fontSize: '2rem', width: 36 }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ margin: '2px 0 12px', fontWeight: 600, fontSize: '1.05rem', lineHeight: 1.4 }}>
                  {q.text ? <QuestionText text={q.text} /> : <span className="dim">{q.clipKind === 'audio' ? 'Audio only — no text' : q.videoId ? 'Video only — no text' : 'Image only — no text'}</span>}
                </div>
                {q.type === 'short' && (
                  <div style={{ fontSize: '0.92rem' }}><strong>Answer:</strong> {q.correctAnswer}{q.accepted ? <span className="dim"> · also accept: {q.accepted}</span> : null}</div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                  {q.options.map((o, oi) => (
                    <div key={oi} data-opt={oi} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px 6px 6px', borderRadius: 8, fontSize: '0.88rem',
                      border: '1px solid', borderColor: o === q.correctAnswer ? 'var(--good)' : 'var(--line)',
                      background: o === q.correctAnswer ? 'color-mix(in srgb, var(--good) 8%, var(--ink-0))' : 'var(--ink-0)',
                    }}>
                      <span className="display" style={{ width: 24, height: 24, borderRadius: 5, display: 'grid', placeItems: 'center', background: 'var(--opt)', color: 'var(--on-opt)', fontSize: '1rem' }}>
                        {OPTION_LABELS[oi]}
                      </span>
                      <span style={{ flex: 1 }}>{o}</span>
                      {o === q.correctAnswer && <strong style={{ color: 'var(--good)' }}>✓</strong>}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <span className="pill">⏱ {q.timeLimit}s</span>
                  <span className="pill">{q.points} pts</span>
                  <span className="pill">{q.type === 'tf' ? 'True / False' : q.type === 'short' ? '🗣 Spoken' : 'Multiple choice'}</span>
                  {q.imageId && <span className="pill">🖼 Picture</span>}
                  {q.videoId && <span className="pill">{q.clipKind === 'audio' ? '🎵 Audio' : '🎬 Video'}</span>}
                  {q.note && <span className="pill">📝 Note</span>}
                  {q.backup && <span className="pill pill-dark">Backup</span>}
                  {!q.isActive && <span className="pill pill-warn">Hidden from game</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setDraft({ ...q, options: q.type === 'mcq' ? [...q.options, '', '', ''].slice(0, 4) : q.options })}>Edit</button>
                <button className="btn btn-ghost btn-sm" onClick={() => move(q, 'up')} disabled={i === 0} aria-label="Move up">↑</button>
                <button className="btn btn-ghost btn-sm" onClick={() => move(q, 'down')} disabled={i === inLevel.length - 1} aria-label="Move down">↓</button>
                <button className="btn btn-danger btn-sm" onClick={() => remove(q)}>Delete</button>
              </div>
            </div>
          </Panel>
        )
      ))}
    </>
  );
}

// ─── Level settings: name, multiplier, delete ────────────────────────────────
function LevelSettings({ level, round, questionCount, guard, onChanged }: {
  level: Level; round: number; questionCount: number;
  guard: <T>(fn: () => Promise<T>) => Promise<T | undefined>; onChanged: () => void;
}) {
  const [name, setName] = useState(level.name);
  const [multiplier, setMultiplier] = useState(String(level.multiplier));
  // Elimination when the level ends ('' = everyone goes through).
  const [rule, setRule] = useState<string>(level.cut?.rule ?? '');
  const [value, setValue] = useState(level.cut ? String(level.cut.value) : '');
  const [ties, setTies] = useState<Cut['ties']>(level.cut?.ties ?? 'speed');
  const [theme, setTheme] = useState(level.theme ?? '');
  const [mode, setMode] = useState<RoundMode>(level.mode ?? 'standard');
  const [afterMiss, setAfterMiss] = useState(level.afterMiss ?? 'next');
  const [untimed, setUntimed] = useState(!!level.untimed);
  const [answerSeconds, setAnswerSeconds] = useState(String(level.answerSeconds ?? 10));
  const [resetScores, setResetScores] = useState(!!level.resetScores);
  const [manualResults, setManualResults] = useState(!!level.manualResults);
  const [fixed, setFixed] = useState(!!level.scoring);
  const [pointsRight, setPointsRight] = useState(String(level.scoring?.correct ?? 10));
  const [pointsWrong, setPointsWrong] = useState(String(level.scoring?.wrong ?? -5));
  const [pointsNone, setPointsNone] = useState(String(level.scoring?.timeout ?? (level.mode === 'buzzer' ? 0 : -5)));
  const scoring = fixed ? { correct: Number(pointsRight), wrong: Number(pointsWrong), timeout: Number(pointsNone) } : null;
  const roundSettings = { afterMiss, untimed, answerSeconds: Number(answerSeconds), resetScores, scoring, manualResults };
  const savedSettings = { afterMiss: level.afterMiss ?? 'next', untimed: !!level.untimed, answerSeconds: level.answerSeconds ?? 10, resetScores: !!level.resetScores, scoring: level.scoring ?? null, manualResults: !!level.manualResults };
  const settingsChanged = JSON.stringify(roundSettings) !== JSON.stringify(savedSettings);
  const turnRound = mode === 'buzzer' || mode === 'passing';
  const cut = rule ? { rule, value: Number(value), ties } : null;
  const cutChanged = JSON.stringify(cut) !== JSON.stringify(level.cut ? { rule: level.cut.rule, value: level.cut.value, ties: level.cut.ties } : null);
  const dirty = name.trim() !== level.name || Number(multiplier) !== level.multiplier || cutChanged || (theme || null) !== level.theme || mode !== level.mode || settingsChanged;
  const valueOk = !rule || (value.trim() !== '' && Number(value) >= (rule === 'min_score' ? 0 : 1)
    && (rule !== 'percent' || Number(value) <= 100) && (['min_score', 'percent'].includes(rule) || Number.isInteger(Number(value))));
  const valid = name.trim().length > 0 && Number(multiplier) > 0 && Number(multiplier) <= 10 && valueOk;
  const unit = CUT_RULES.find(r => r.id === rule)?.unit;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    guard(async () => {
      await api(`/levels/${level.number}`, { method: 'PUT', body: { name: name.trim(), multiplier: Number(multiplier), theme: theme || null, mode, cut, ...roundSettings } });
      onChanged();
    });
  };
  const remove = () => {
    if (!confirm(`Delete the level "${level.name}"?`)) return;
    guard(async () => { await api(`/levels/${level.number}`, { method: 'DELETE' }); onChanged(); });
  };
  const setActive = (active: boolean) => guard(async () => {
    await api(`/levels/${level.number}/active`, { method: 'PUT', body: { active } });
    onChanged();
  });

  return (
    <Panel>
      <form onSubmit={save} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-row" style={{ flex: '1 1 220px' }}>
          <label className="eyebrow" htmlFor="lvl-name">{level.isActive ? `Level ${round} name` : 'Level name (off)'}</label>
          <input id="lvl-name" className="field field-sm" value={name} maxLength={40} onChange={e => setName(e.target.value)} required />
        </div>
        <div className="form-row" style={{ flex: '0 1 140px' }}>
          <label className="eyebrow" htmlFor="lvl-mult">Points ×</label>
          <input id="lvl-mult" className="field field-sm" type="number" min={0.1} max={10} step={0.1} value={multiplier}
            onChange={e => setMultiplier(e.target.value)} required />
        </div>
        <div className="form-row" style={{ flex: '1 1 240px' }}>
          <label className="eyebrow" htmlFor="lvl-mode">Round type</label>
          <select id="lvl-mode" className="field field-sm" value={mode} onChange={e => setMode(e.target.value as RoundMode)}>
            {ROUND_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        {mode === 'passing' && (
          <div className="form-row" style={{ flex: '1 1 240px' }}>
            <label className="eyebrow" htmlFor="lvl-miss">After a pass or wrong answer</label>
            <select id="lvl-miss" className="field field-sm" value={afterMiss} onChange={e => setAfterMiss(e.target.value as Level['afterMiss'])}>
              <option value="next">Goes to the next player</option>
              <option value="close">Question closes</option>
            </select>
          </div>
        )}
        {(mode === 'buzzer' || mode === 'display') && (
          <div className="form-row" style={{ flex: '1 1 200px' }}>
            <label className="eyebrow" htmlFor="lvl-timer">Time limit per question</label>
            <select id="lvl-timer" className="field field-sm" value={untimed ? 'off' : 'on'} onChange={e => setUntimed(e.target.value === 'off')}>
              <option value="on">{mode === 'display' ? "Show the question's timer" : "Use the question's timer"}</option>
              <option value="off">{mode === 'display' ? 'No timer' : 'No limit — coordinator closes it'}</option>
            </select>
          </div>
        )}
        {mode === 'buzzer' && !manualResults && (
          <div className="form-row" style={{ flex: '0 1 150px' }}>
            <label className="eyebrow" htmlFor="lvl-answer">Seconds to answer</label>
            <input id="lvl-answer" className="field field-sm" type="number" min={1} max={120} value={answerSeconds} onChange={e => setAnswerSeconds(e.target.value)} required />
          </div>
        )}
        <div className="form-row" style={{ flex: '1 1 220px' }}>
          <label className="eyebrow" htmlFor="lvl-theme">Look on screen</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, border: '2px solid #111', background: THEMES.find(t => t.id === theme)?.swatch ?? 'repeating-linear-gradient(45deg, #ffc21a 0 6px, #ff4fa8 6px 12px, #a6d91a 12px 18px, #93b8ff 18px 24px)' }} />
            <select id="lvl-theme" className="field field-sm" value={theme} onChange={e => setTheme(e.target.value)}>
              <option value="">Automatic (changes every round)</option>
              {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row" style={{ flex: '1 1 240px' }}>
          <label className="eyebrow" htmlFor="lvl-cut">After this level</label>
          <select id="lvl-cut" className="field field-sm" value={rule} onChange={e => { setRule(e.target.value); if (!e.target.value) setValue(''); }}>
            <option value="">Everyone goes through</option>
            {CUT_RULES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </div>
        {rule && (
          <>
            <div className="form-row" style={{ flex: '0 1 130px' }}>
              <label className="eyebrow" htmlFor="lvl-cut-value">{unit}</label>
              <input id="lvl-cut-value" className="field field-sm" type="number" min={rule === 'min_score' ? 0 : 1} max={rule === 'percent' ? 100 : undefined}
                step={rule === 'min_score' || rule === 'percent' ? 'any' : 1} value={value} onChange={e => setValue(e.target.value)} required />
            </div>
            <div className="form-row" style={{ flex: '1 1 210px' }}>
              <label className="eyebrow" htmlFor="lvl-cut-ties">Tie at the line</label>
              <select id="lvl-cut-ties" className="field field-sm" value={ties} onChange={e => setTies(e.target.value as Cut['ties'])}>
                <option value="speed">Faster player goes through</option>
                <option value="include">Everyone tied goes through</option>
              </select>
            </div>
          </>
        )}
        {turnRound && (
          <label style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
            <input type="checkbox" checked={manualResults} onChange={e => setManualResults(e.target.checked)} style={{ width: 18, height: 18 }} />
            Results kept by hand: the buzzer and passes run here, but the system records no points, standings or winners
          </label>
        )}
        {turnRound && !manualResults && (
          <div style={{ flex: '1 1 100%', display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem', paddingBottom: 8 }}>
              <input type="checkbox" checked={fixed} onChange={e => setFixed(e.target.checked)} style={{ width: 18, height: 18 }} /> Fixed points
            </label>
            {fixed && [['Correct', pointsRight, setPointsRight], ['Wrong', pointsWrong, setPointsWrong], ['No answer', pointsNone, setPointsNone]].map(([label, value, set]) => (
              <div className="form-row" style={{ flex: '0 1 110px' }} key={label as string}>
                <label className="eyebrow">{label as string}</label>
                <input className="field field-sm" type="number" step={1} value={value as string} onChange={e => (set as (v: string) => void)(e.target.value)} required />
              </div>
            ))}
          </div>
        )}
        {mode !== 'display' && !manualResults && <label style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
          <input type="checkbox" checked={resetScores} onChange={e => setResetScores(e.target.checked)} style={{ width: 18, height: 18 }} />
          Everyone starts this level at 0 (use on the first round of the final, so earlier rounds only pick the finalists)
        </label>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActive(!level.isActive)}>{level.isActive ? 'Turn level off' : 'Turn level on'}</button>
        <button className="btn btn-ghost btn-sm" disabled={!dirty || !valid}>Save level</button>
        <button type="button" className="btn btn-danger btn-sm" onClick={remove} disabled={questionCount > 0}
          title={questionCount > 0 ? 'Move or delete its questions first' : undefined}>Delete level</button>
      </form>
      {mode !== level.mode && (
        <p role="status" style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--heat)', margin: '10px 0 0' }}>
          Press Save level to switch to this round type. Until then, new questions follow the saved type.
        </p>
      )}
      <p className="dim" style={{ fontSize: '0.8rem', margin: '10px 0 0' }}>
        Shown on the projector and phones when this round starts. Levels are played in the order of the tabs; empty levels are skipped.
        A level that is turned off stays here with its questions but is not played, and the levels after it are renumbered.
        "After this level" decides who goes on when its last question ends; the coordinator reviews the list and confirms it in the host console. The last level has no cut.
      </p>
      {mode === 'display' && (
        <p className="dim" style={{ fontSize: '0.8rem', margin: '6px 0 0' }}>
          Show only: the projector shows each question, and the coordinator shows the answer and moves on. Phones just say to watch the screen. Nothing is collected or scored here: the quiz master runs the answers and scores by hand. If the last level is show only, the game ends without ranking anyone.
        </p>
      )}
      {mode === 'buzzer' && (
        <p className="dim" style={{ fontSize: '0.8rem', margin: '6px 0 0' }}>
          {manualResults
            ? 'Buzzer: questions are spoken, with no options. Everyone can press once and nobody locks. The projector and host console show the order they pressed in, and the quiz master takes answers in that order.'
            : "Buzzer: questions are spoken, with no options. The first to buzz gets the question and the other buzzers lock, and the coordinator marks the answer. A wrong answer locks that player out and reopens the question to the others, one attempt each. Without fixed points, a correct answer earns the question's points and a wrong one costs half."}
        </p>
      )}
      {mode === 'passing' && (
        <p className="dim" style={{ fontSize: '0.8rem', margin: '6px 0 0' }}>
          Turns: questions are spoken, with no options. Each question goes to one player, and the first go moves along with each question, so 5 finalists and 15 questions give 3 each. The coordinator marks the answer and decides if time runs out. If the question goes to the next player, each later turn is half the timer, it reaches 6 players at most, and without fixed points it is worth half.
        </p>
      )}
    </Panel>
  );
}

// ─── Question picture: upload (resized in the browser), preview, remove ──────
// Stored encrypted like the question; shown on the projector and phones only when the question is live.
async function resizeImage(file: File, maxSide = 1600): Promise<{ mime: string; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // transparent PNGs get a white background in JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { mime: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

// A question's video or audio clip, kept in the private video bucket. The preview uses a short-lived link from the server.
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const mediaUrl = (url: string) => (url.startsWith('/') ? `${API_BASE}${url}` : url); // local Supabase: through the API server
const CLIP_FILES = {
  video: { accept: 'video/mp4,video/webm', name: 'video', hint: 'an MP4 or WebM video' },
  audio: { accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/ogg,audio/webm,.mp3,.m4a,.wav,.ogg', name: 'audio clip', hint: 'an MP3, M4A, WAV or OGG file' },
};
function QuestionVideoPicker({ kind, videoId, onChange }: { kind: 'audio' | 'video'; videoId: string | null; onChange: (id: string | null) => void }) {
  const clip = CLIP_FILES[kind];
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!videoId) { setPreview(null); return; }
    api<{ url: string }>(`/questions/videos/${videoId}`).then(r => setPreview(mediaUrl(r.url))).catch(() => setError('Could not load the clip'));
  }, [videoId]);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (file.size > VIDEO_MAX_BYTES) { setError('The file must be under 50 MB'); return; }
    setBusy(true);
    try {
      // The file goes straight to storage with a one-time link: too big to pass through the API.
      const { url, path } = await api<{ url: string; path: string }>('/questions/videos/upload', { method: 'POST', body: { mime: file.type, bytes: file.size } });
      const res = await fetch(mediaUrl(url), { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!res.ok) throw new Error(`Upload failed — check the file is ${clip.hint} under 50 MB`);
      const saved = await api<{ id: string }>('/questions/videos', { method: 'POST', body: { path } });
      onChange(saved.id);
    } catch (err) {
      setError((err as Error).message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-row" style={{ marginTop: 14 }}>
      <span className="eyebrow">{kind === 'audio' ? 'Audio clip' : 'Video'} — played on the projector before the question and timer, up to 50 MB</span>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {preview && (kind === 'audio'
          ? <audio src={preview} controls style={{ width: 280 }} />
          : <video src={preview} controls playsInline style={{ width: 240, maxHeight: 160, border: '1px solid var(--line-strong)', borderRadius: 8, background: '#000' }} />)}
        <label className="btn btn-ghost btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Uploading…' : `${videoId ? 'Replace' : '+ Add'} ${clip.name}`}
          <input type="file" accept={clip.accept} onChange={pick} disabled={busy} style={{ display: 'none' }} />
        </label>
        {videoId && <button type="button" className="btn btn-danger btn-sm" onClick={() => onChange(null)} disabled={busy}>Remove {clip.name}</button>}
      </div>
      {error && <p className="error-text" style={{ textAlign: 'left' }}>{error}</p>}
    </div>
  );
}

function QuestionImage({ imageId, onChange }: { imageId: string | null; onChange: (id: string | null) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!imageId) { setPreview(null); return; }
    let url: string | null = null;
    fetchObjectUrl(`/questions/images/${imageId}`).then(u => { url = u; setPreview(u); }).catch(() => setError('Could not load the picture'));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [imageId]);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const image = await resizeImage(file);
      const saved = await api<{ id: string }>('/questions/images', { method: 'POST', body: image });
      onChange(saved.id);
    } catch (err) {
      setError((err as Error).message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-row" style={{ marginTop: 14 }}>
      <span className="eyebrow">Picture — shown on the projector while the question is live</span>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {preview && <img src={preview} alt="Question picture" style={{ width: 180, height: 120, objectFit: 'contain', border: '1px solid var(--line-strong)', borderRadius: 8, background: '#fff' }} />}
        <label className="btn btn-ghost btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Uploading…' : imageId ? 'Replace picture' : '+ Add picture'}
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} disabled={busy} style={{ display: 'none' }} />
        </label>
        {imageId && <button type="button" className="btn btn-danger btn-sm" onClick={() => onChange(null)} disabled={busy}>Remove picture</button>}
      </div>
      {error && <p className="error-text" style={{ textAlign: 'left' }}>{error}</p>}
    </div>
  );
}

// ─── Editor ───────────────────────────────────────────────────────────────────
function Editor({ draft, levels, onSave, onCancel }: {
  draft: Draft; levels: Level[]; onSave: (d: Draft) => Promise<unknown>; onCancel: () => void;
}) {
  const fitLevel = (q: Draft): Draft => (spokenOnly(levels, q.level) && q.type !== 'short' ? { ...q, type: 'short', options: [] } : q);
  const [d, setD] = useState<Draft>(() => fitLevel(draft));
  const [saving, setSaving] = useState(false);
  const [format, setFormat] = useState<Format>(() => formatOf(draft));
  const usesImage = format === 'image' || format === 'image_text';
  const usesClip = format === 'audio' || format === 'video';
  // Switching format drops media the new format doesn't use (the server removes it on save).
  const chooseFormat = (next: Format) => {
    const keepImage = next === 'image' || next === 'image_text';
    const keepClip = next === 'audio' || next === 'video' ? d.clipKind === next : false;
    setFormat(next);
    setD({ ...d, imageId: keepImage ? d.imageId : null, videoId: keepClip ? d.videoId : null, clipKind: keepClip ? d.clipKind : null });
  };
  const mediaMissing = (usesImage && !d.imageId) || (usesClip && !d.videoId);
  const spoken = d.type === 'short';
  const levelOfDraft = levels.find(l => l.number === d.level);
  const canSpeak = levelOfDraft?.mode !== undefined && levelOfDraft.mode !== 'standard';
  const noOptions = spokenOnly(levels, d.level);
  const options = d.type === 'tf' ? ['True', 'False'] : d.options;
  const filled = options.map(o => o.trim()).filter(Boolean);

  const setOption = (i: number, value: string) => {
    const next = [...d.options];
    const wasCorrect = d.correctAnswer === d.options[i];
    next[i] = value;
    setD({ ...d, options: next, correctAnswer: wasCorrect ? value : d.correctAnswer });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await onSave({ ...d, text: format === 'image' ? '' : d.text, options: spoken ? [] : d.type === 'tf' ? ['True', 'False'] : filled, correctAnswer: d.correctAnswer.trim() });
    setSaving(false);
  };

  return (
    <Panel bracketed className="panel-lg">
      <form onSubmit={submit}>
        <div className="eyebrow">{d.id ? 'Edit question' : 'New question'}</div>
        <div className="form-row" style={{ marginTop: 14 }}>
          <span className="eyebrow">Question format</span>
          <div role="radiogroup" aria-label="Question format" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FORMATS.map(f => (
              <button key={f.id} type="button" role="radio" aria-checked={format === f.id}
                className={`btn btn-sm ${format === f.id ? 'btn-heat' : 'btn-ghost'}`} onClick={() => chooseFormat(f.id)}>{f.label}</button>
            ))}
          </div>
        </div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="form-row">
            <label className="eyebrow" htmlFor="q-level">Level</label>
            <select id="q-level" className="field field-sm" value={d.level} onChange={e => setD(fitLevel({ ...d, level: Number(e.target.value) }))}>
              {levels.map(l => <option key={l.number} value={l.number}>{l.isActive ? `Level ${roundOf(levels, l)}` : 'Off'} · {l.name}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label className="eyebrow" htmlFor="q-type">Type</label>
            <select id="q-type" className="field field-sm" value={d.type}
              onChange={e => setD({ ...d, type: e.target.value as Draft['type'], correctAnswer: '', accepted: '', options: e.target.value === 'tf' ? ['True', 'False'] : ['', '', '', ''] })}>
              <option value="mcq" disabled={noOptions}>Multiple choice — options on phones{noOptions ? ' (not in a buzzer or turns level)' : ''}</option>
              <option value="tf" disabled={noOptions}>True / False{noOptions ? ' (not in a buzzer or turns level)' : ''}</option>
              <option value="short" disabled={!canSpeak}>Spoken — no options, coordinator marks it{canSpeak ? '' : ' (needs a buzzer or turns level)'}</option>
            </select>
          </div>
          <div className="form-row">
            <label className="eyebrow" htmlFor="q-time">Timer (seconds)</label>
            <input id="q-time" className="field field-sm" type="number" min={5} max={300} value={d.timeLimit}
              onChange={e => setD({ ...d, timeLimit: Number(e.target.value) })} required />
          </div>
          <div className="form-row">
            <label className="eyebrow" htmlFor="q-points">Base points</label>
            <input id="q-points" className="field field-sm" type="number" min={100} max={10000} step={50} value={d.points}
              onChange={e => setD({ ...d, points: Number(e.target.value) })} required />
          </div>
        </div>

        {format !== 'image' && (
          <div className="form-row" style={{ marginTop: 14 }}>
            <label className="eyebrow" htmlFor="q-text">{usesClip ? 'Question (optional)' : 'Question'}</label>
            <textarea id="q-text" className="field" value={d.text} onChange={e => setD({ ...d, text: e.target.value })} maxLength={1000} required={!usesClip}
              placeholder={format === 'audio' ? 'e.g. Which film is this dialogue from?' : format === 'image_text' ? 'e.g. Name the actor in this still' : 'e.g. Who directed Drishyam?'} />
          </div>
        )}

        {usesImage && <QuestionImage imageId={d.imageId ?? null} onChange={imageId => setD({ ...d, imageId })} />}
        {usesClip && <QuestionVideoPicker kind={format as 'audio' | 'video'} videoId={d.videoId ?? null} onChange={videoId => setD({ ...d, videoId, clipKind: videoId ? format as 'audio' | 'video' : null })} />}

        {spoken ? (
          <div className="form-grid" style={{ marginTop: 16 }}>
            <div className="form-row">
              <label className="eyebrow" htmlFor="q-answer">Answer (the coordinator sees it first; the projector shows it at the reveal)</label>
              <input id="q-answer" className="field field-sm" value={d.correctAnswer} onChange={e => setD({ ...d, correctAnswer: e.target.value })} maxLength={160} required />
            </div>
            <div className="form-row">
              <label className="eyebrow" htmlFor="q-accepted">Also accept (optional)</label>
              <input id="q-accepted" className="field field-sm" value={d.accepted ?? ''} onChange={e => setD({ ...d, accepted: e.target.value })} maxLength={300} placeholder="Other spellings, remakes" />
            </div>
          </div>
        ) : <fieldset style={{ border: 0, padding: 0, margin: '16px 0 0' }}>
          <legend className="eyebrow" style={{ marginBottom: 10 }}>Options — tick the correct answer</legend>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 10 }}>
            {options.map((o, i) => (
              <div key={i} data-opt={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="display" style={{ width: 34, height: 40, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--opt)', color: 'var(--on-opt)', fontSize: '1.3rem', flexShrink: 0 }}>
                  {OPTION_LABELS[i]}
                </span>
                {d.type === 'tf' ? (
                  <span style={{ flex: 1, fontWeight: 600 }}>{o}</span>
                ) : (
                  <input className="field field-sm" value={o} onChange={e => setOption(i, e.target.value)} maxLength={160}
                    placeholder={i < 2 ? `Option ${OPTION_LABELS[i]} (required)` : `Option ${OPTION_LABELS[i]} (optional)`} required={i < 2} />
                )}
                <input type="radio" name="correct" aria-label={`Option ${OPTION_LABELS[i]} is correct`} checked={!!o.trim() && d.correctAnswer === o}
                  disabled={!o.trim()} onChange={() => setD({ ...d, correctAnswer: o })} style={{ width: 20, height: 20, accentColor: 'var(--good)' }} />
              </div>
            ))}
          </div>
        </fieldset>}

        <div className="form-row" style={{ marginTop: 14 }}>
          <label className="eyebrow" htmlFor="q-note">Answer note (optional)</label>
          <textarea id="q-note" className="field" value={d.note ?? ''} onChange={e => setD({ ...d, note: e.target.value })} maxLength={300}
            placeholder="Shown on phones and the projector after the reveal, e.g. Released in 2013, directed by Jeethu Joseph." />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, fontSize: '0.9rem' }}>
          <input type="checkbox" checked={!!d.backup} onChange={e => setD({ ...d, backup: e.target.checked })} style={{ width: 18, height: 18 }} />
          Spare question (played only to replace a cancelled question, or in a sudden death)
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: '0.9rem' }}>
          <input type="checkbox" checked={d.isActive} onChange={e => setD({ ...d, isActive: e.target.checked })} style={{ width: 18, height: 18 }} />
          Include in the game (untick to keep it as a draft)
        </label>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="submit" className="btn btn-heat" disabled={saving || mediaMissing || !d.correctAnswer.trim() || (!spoken && !options.includes(d.correctAnswer))}>
            {saving ? 'Saving…' : d.id ? 'Save changes' : 'Add question'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </form>
    </Panel>
  );
}

// ─── Set tools: import from a spreadsheet, check the set, print the answer sheet ──
function SetTools({ questions, levels, guard, reload }: {
  questions: Question[]; levels: Level[]; guard: (fn: () => Promise<unknown>) => unknown; reload: () => Promise<unknown>;
}) {
  const [notes, setNotes] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);

  const download = () => {
    const url = URL.createObjectURL(new Blob([IMPORT_TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'moviequiz-questions-template.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const parsed = parseQuestionImport(await file.text(), levels);
    setChecked(false);
    if (parsed.errors.length) { setNotes(parsed.errors); return; }
    if (!confirm(`Add ${parsed.questions.length} questions to this set?`)) return;
    guard(async () => {
      const r = await api<{ imported: number }>('/questions/import', { method: 'POST', body: { questions: parsed.questions } });
      setNotes([`Imported ${r.imported} questions. Add pictures and clips in the editor.`]);
      await reload();
    });
  };

  const check = () => {
    setChecked(true);
    setNotes(checkSet(questions, levels));
  };

  return (
    <Panel>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
          Import from spreadsheet (CSV)
          <input type="file" accept=".csv,text/csv" onChange={importFile} style={{ display: 'none' }} />
        </label>
        <button type="button" className="btn btn-ghost btn-sm" onClick={download}>Download template</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={check}>Check this set</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()}>Print answer sheet</button>
      </div>
      <p className="dim" style={{ fontSize: '0.78rem', margin: '8px 0 0' }}>Columns: {importColumns}. From Excel, use Save As → CSV. Round is the number on the tabs below.</p>
      {checked && notes.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '0.9rem' }}>✓ No problems found.</p>}
      {notes.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: '0.9rem', lineHeight: 1.5 }}>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </Panel>
  );
}

// Printed by the quiz master; on screen it stays hidden (see .print-sheet in index.css).
function AnswerSheet({ questions, levels, bankName }: { questions: Question[]; levels: Level[]; bankName: string }) {
  const rounds = levels.filter(l => l.isActive);
  return (
    <div className="print-sheet">
      <h1>{bankName} — answer sheet</h1>
      {rounds.map((level, r) => {
        const inLevel = questions.filter(q => q.level === level.number && q.isActive);
        if (!inLevel.length) return null;
        return (
          <section key={level.number}>
            <h2>Round {r + 1}: {level.name}</h2>
            <table>
              <tbody>
                {inLevel.map((q, i) => (
                  <tr key={q.id}>
                    <td>{q.backup ? 'Spare' : i + 1}</td>
                    <td>{q.text || (q.clipKind === 'audio' ? '[Audio clip]' : q.videoId ? '[Video clip]' : '[Picture]')}</td>
                    <td>
                      <strong>{q.correctAnswer}</strong>
                      {q.accepted ? <div>Also: {q.accepted}</div> : null}
                      {q.note ? <div>{q.note}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
