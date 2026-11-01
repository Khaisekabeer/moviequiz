import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { avatarUri } from '../lib/avatar';

export const OPTION_LABELS = ['A', 'B', 'C', 'D'];

export const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 100 < 11 || n % 100 > 13 ? n % 10 : 0] ?? 'th'}`;
// Round types other than a standard round, and how they are explained to players.
export const ROUND_LABEL: Record<string, string> = { buzzer: '🔔 Buzzer round', passing: '🎯 Turns round', display: '🎬 On stage' };
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
export function roundRule(config: any): string {
  if (config?.mode === 'display') return 'Answers are given out loud. The quiz master keeps the score.';
  if (config?.manualResults) return `${config.mode === 'buzzer' ? 'Everyone can buzz. The screen shows the order.' : 'Answer out loud or pass.'} The quiz master keeps the score.`;
  const points = config?.scoring;
  if (config?.mode === 'buzzer') {
    return `First to buzz answers. ${points ? `Correct ${signed(points.correct)}, wrong ${signed(points.wrong)}.` : 'A wrong answer costs half the points.'}`;
  }
  if (config?.mode === 'passing') {
    const turns = config.afterMiss === 'close' ? 'One player per question.' : 'Missed questions go to the next player.';
    return `${turns} ${points ? `Correct ${signed(points.correct)}, pass 0, wrong ${signed(points.wrong)}.` : 'Passed questions are worth half.'}`;
  }
  return '';
}

// Chakravyuha mark: three broken concentric rings, each opening offset like a formation's gate.
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="56 10" transform="rotate(-60 12 12)" />
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="33 8" transform="rotate(120 12 12)" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

// Program name first; the festival it belongs to as a small tag.
export function Brand({ size, event = true }: { size?: string; event?: boolean }) {
  return (
    <span className="brand" style={size ? { fontSize: size } : undefined}>
      <img src={`${import.meta.env.BASE_URL}vyuham-logo.png`} alt="Vyuham" className="brand-logo" />
      Movie Quiz
      {event && <span className="brand-event">Vyuham '26</span>}
    </span>
  );
}

// Slowly rotating concentric rings: the backdrop motif.
export function Rings({ size = 640, style }: { size?: number | string; style?: CSSProperties }) {
  return (
    <svg className="rings" viewBox="0 0 400 400" style={{ width: size, ...style }} aria-hidden="true">
      <g className="r-spin">
        <circle cx="200" cy="200" r="196" strokeWidth="1" strokeDasharray="2 10" opacity="0.5" />
        <circle cx="200" cy="200" r="150" strokeWidth="1.2" strokeDasharray="700 242" opacity="0.35" />
      </g>
      <g className="r-spin-rev">
        <circle cx="200" cy="200" r="172" strokeWidth="0.8" opacity="0.18" />
        <circle cx="200" cy="200" r="112" strokeWidth="1.2" strokeDasharray="520 184" opacity="0.4" />
        <circle cx="200" cy="200" r="74" strokeWidth="0.8" strokeDasharray="1 6" opacity="0.6" />
      </g>
      <circle className="r-pulse" cx="200" cy="200" r="40" strokeWidth="1.5" />
      <circle cx="200" cy="200" r="4" fill="currentColor" stroke="none" opacity="0.8" />
    </svg>
  );
}

export function TimerRing({ value, max, size = 56, stroke = 3, fontSize }: {
  value: number; max: number; size?: number; stroke?: number; fontSize?: string;
}) {
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const progress = Math.max(0, Math.min(1, value / max));
  const urgent = value <= 5;
  return (
    <div className={`timer${urgent ? ' urgent' : ''}`} style={{ width: size, height: size }} role="timer" aria-label={`${value} seconds left`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle
          className="bar" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - progress)} strokeLinecap="butt"
        />
      </svg>
      <span className="count" style={{ fontSize: fontSize ?? `${size * 0.42}px` }}>{value}</span>
    </div>
  );
}

// QR code generated locally (no internet needed), so players can scan instead of typing the address.
export function QrCode({ value, size }: { value: string; size: number | string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0a0a0a', light: '#ffffff' } })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [value]);
  return (
    <div
      role="img"
      aria-label={`QR code for ${value}`}
      style={{ width: size, height: size, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: svg.replace('<svg', '<svg width="100%" height="100%"') }}
    />
  );
}

export function Toast({ msg }: { msg: string }) {
  return <div className="toast" role="status">{msg}</div>;
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="stage" data-staff="door" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <svg className="reel" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="30" fill="#ffcd4d" />
        {[0, 72, 144, 216, 288].map(a => <circle key={a} cx="32" cy="14" r="7" fill="#101a3a" transform={`rotate(${a} 32 32)`} />)}
        <circle cx="32" cy="32" r="4" fill="#101a3a" />
      </svg>
      <p className="comic-title" style={{ marginTop: 20, fontSize: 'clamp(1.6rem, 5vw, 2.4rem)', color: '#ffcd4d' }}>{label}</p>
    </div>
  );
}

export function Panel({ children, style, bracketed, className = '' }: {
  children: ReactNode; style?: CSSProperties; bracketed?: boolean; className?: string;
}) {
  return (
    <section className={`panel${bracketed ? ' bracketed' : ''} ${className}`} style={{ padding: '20px 22px', ...style }}>
      {children}
    </section>
  );
}

// Staggered entrance helper: <Rise d={120}>…</Rise>
export function Rise({ d = 0, as: Tag = 'div', className = '', style, children }: {
  d?: number; as?: 'div' | 'span' | 'p' | 'h1' | 'h2'; className?: string; style?: CSSProperties; children: ReactNode;
}) {
  return <Tag className={`rise ${className}`} style={{ ...style, ['--d' as string]: `${d}ms` }}>{children}</Tag>;
}

// ─── Vyuham '26 + comic theme pieces ─────────────────────────────────────────

// The Vyuham logo (red mark; white version for dark backgrounds).
export function VyuhamLogo({ height = 40, white = false, style }: { height?: number | string; white?: boolean; style?: CSSProperties }) {
  return <img src={`${import.meta.env.BASE_URL}${white ? 'vyuham-logo-white.png' : 'vyuham-logo.png'}`} alt="Vyuham" style={{ height, width: 'auto', display: 'block', ...style }} />;
}

// Sunburst + halftone backdrop of a themed stage (put it first inside <div className="stage" data-theme>).
export function ComicBg({ slashes = false }: { slashes?: boolean }) {
  return (
    <>
      <div className="comic-bg" aria-hidden="true" />
      {slashes && (
        <>
          <div className="comic-slash" aria-hidden="true" style={{ top: '-24vmax', right: '-20vmax' }} />
          <div className="comic-slash" aria-hidden="true" style={{ bottom: '-26vmax', left: '-22vmax' }} />
        </>
      )}
    </>
  );
}

// Starburst speech bubble behind its children.
const BURST_POINTS = (() => {
  const spikes = 18;
  const pts: string[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (Math.PI * i) / spikes - Math.PI / 2;
    // Irregular spikes, like a hand-drawn comic burst (deterministic, so it doesn't jitter).
    const r = i % 2 === 0 ? 50 : 36 + ((i * 37) % 9);
    pts.push(`${(50 + r * Math.cos(angle)).toFixed(1)},${(50 + r * Math.sin(angle) * 0.82).toFixed(1)}`);
  }
  return pts.join(' ');
})();

export function Burst({ children, style, className = '' }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <div className={`burst ${className}`} style={style}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <pattern id="burst-dots" width="3" height="3" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="0.55" className="burst-dots" />
          </pattern>
        </defs>
        <polygon points={BURST_POINTS} />
        <ellipse cx="50" cy="56" rx="26" ry="16" fill="url(#burst-dots)" opacity="0.5" />
      </svg>
      {children}
    </div>
  );
}

export function Avatar({ id, size = 40, style }: { id?: string | null; size?: number | string; style?: CSSProperties }) {
  return (
    <span className="avatar" style={{ width: size, height: size, display: 'inline-block', ...style }}>
      <img src={avatarUri(id)} alt="" loading="lazy" />
    </span>
  );
}
