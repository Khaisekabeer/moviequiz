import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ScreenSocket } from './SocketContext'
import { DEVICES, hooks, payload, sockets, steps, type Device } from './runtime'
import { openSet } from './mockApi'
import BigScreen from '../src/pages/BigScreen'
import HostConsole from '../src/pages/HostConsole'
import ParticipantView from '../src/pages/ParticipantView'
import Admin from '../src/pages/Admin'
import LiveMonitor from '../src/pages/admin/LiveMonitor'
import { session, type Role } from '../src/lib/api'

const CHAPTERS: Record<string, { name: string; kind: string }> = {
  prep: { name: 'Before the day', kind: 'Staff pages' },
  door: { name: 'At the door', kind: 'Check-in and lobby' },
  r1: { name: 'Round 1 · Indian Cinema', kind: 'Standard' },
  r2: { name: 'Round 2 · World Cinema', kind: 'Standard, top 5 go through' },
  r3: { name: 'Round 3 · Beyond the Frame', kind: 'Turns, results by hand' },
  r4: { name: 'Round 4 · The Final Cut', kind: 'Buzzer, results by hand' },
  extra: { name: 'Other options', kind: 'Scored rounds, tie-breaks, podium' },
}
const CHAPTER_IDS = Object.keys(CHAPTERS)

// A logical screen: its real size, and whether it fits whole in its slot or fills the slot's width.
const SIZES: Record<string, { w: number; h: number; fill?: boolean }> = {
  screen: { w: 1920, h: 1080 },
  phone: { w: 390, h: 844 },
  host: { w: 860, h: 0, fill: true },
  hostFull: { w: 1280, h: 0, fill: true },
  staff: { w: 1180, h: 0, fill: true },
}
const PLAYERS: Record<string, Record<string, string>> = {
  main: { p1: 'Ananya', p2: 'Rohan', p3: 'Meera' },
  options: { p1: 'Ananya', p2: 'Rohan', p3: 'Joel' },
}
const VIEWS = [
  { id: 'all', label: 'All screens' },
  { id: 'screen', label: 'Projector' },
  { id: 'host', label: 'Host console' },
  { id: 'phones', label: 'Phones' },
  { id: 'monitor', label: 'Live monitor' },
] as const
type View = typeof VIEWS[number]['id']

const stepFromHash = () => {
  const n = Number(location.hash.match(/^#step-(\d+)$/)?.[1])
  return n >= 1 && n <= steps.length ? n - 1 : DEFAULT_STEP
}
// Opens on a question that is live, with every screen doing something.
const DEFAULT_STEP = Math.max(0, steps.findIndex((s: any) => s.title === 'Answers come in'))
const dwell = (s: any) => Math.max(4200, s.body.length * 62)

function setStaffSession(role: Role | null | undefined) {
  if (!role) return session.clear()
  session.set({ token: 'demo', staff: { id: role === 'admin' ? 's1' : 's3', username: role, displayName: role === 'quizmaster' ? 'Quiz Master' : role === 'volunteer' ? 'Volunteer One' : role === 'admin' ? 'Festival Admin' : 'Coordinator', role } })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Finds a button by its words: an exact match first, so "Check" is not the "Check-in" tab.
function findButton(root: HTMLElement, label: string) {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')]
  const text = (b: HTMLElement) => (b.textContent ?? '').trim()
  return buttons.find(b => text(b) === label) ?? buttons.find(b => text(b).includes(label) || (b.getAttribute('aria-label') ?? '').includes(label))
}

async function until<T>(find: () => T | null | undefined): Promise<T | null> {
  for (let i = 0; i < 40; i++) {
    const hit = find()
    if (hit) return hit
    await sleep(50)
  }
  return null
}

// Carries out a step's scripted clicks and typing on a real page.
async function drive(device: Device, ops: any[], isCurrent: () => boolean) {
  const root = () => sockets[device].root
  for (const op of ops) {
    if (!isCurrent()) return
    if (op.click) {
      const button = await until(() => { const b = root() && findButton(root()!, op.click); return b && !b.disabled ? b : null })
      button?.click()
    } else if (op.type) {
      const input = await until(() => root()?.querySelector<HTMLInputElement>(op.type[0]))
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, op.type[1])
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    } else if (op.scroll) {
      const target = await until(() => root()?.querySelector<HTMLElement>(op.scroll))
      const scroller = root()?.closest<HTMLElement>('.d-scroll')
      if (target && scroller) {
        const scale = scroller.getBoundingClientRect().width / scroller.offsetWidth
        scroller.scrollTop += (target.getBoundingClientRect().top - scroller.getBoundingClientRect().top) / scale - 16
      }
    }
    await sleep(140)
  }
}

export default function Shell() {
  const [index, setIndex] = useState(stepFromHash)
  const [keys, setKeys] = useState<Record<string, number>>({})
  const [view, setView] = useState<View>('all')
  const [playing, setPlaying] = useState(false)
  const [openChapter, setOpenChapter] = useState<string | null>(null)
  const current = useRef(index)
  const step = steps[index]

  const prepare = useCallback((s: any) => {
    openSet.on = !!s.staff?.vault
    setStaffSession(s.staff ? s.staff.role : 'coordinator')
    try { (globalThis as any).__demoStorage.setItem('techsprint_admin_tab', s.staff?.tab ?? 'live') } catch { /* the first tab shows */ }
    for (const d of DEVICES) sockets[d].ack = s.acks?.[d] ?? null
  }, [])

  const load = useCallback((to: number) => {
    const s = steps[to]
    prepare(s)
    for (const d of DEVICES) {
      sockets[d].cancel()
      sockets[d].snap = s.snap[d === 'staff' || d === 'staffPhone' ? 'monitor' : d] ?? null
    }
    setKeys(k => Object.fromEntries(DEVICES.map(d => [d, (k[d] ?? 0) + 1])))
  }, [prepare])

  const go = useCallback((to: number) => {
    if (to < 0 || to >= steps.length || to === current.current) return
    const s = steps[to]
    if (to === current.current + 1 && !s.jump) {
      prepare(s)
      const fresh = new Set<string>(s.remount ?? [])
      for (const d of DEVICES) {
        if (fresh.has(d)) sockets[d].snap = s.snap[d]
        else if (s.events[d]?.length) sockets[d].play(s.events[d])
      }
      if (fresh.size) setKeys(k => ({ ...k, ...Object.fromEntries([...fresh].map(d => [d, (k[d] ?? 0) + 1])) }))
    } else {
      load(to)
    }
    current.current = to
    setIndex(to)
    setOpenChapter(null)
    try { history.replaceState(null, '', `#step-${to + 1}`) } catch { /* the viewer keeps its own address */ }
  }, [load, prepare])

  useLayoutEffect(() => load(index), []) // eslint-disable-line react-hooks/exhaustive-deps

  // The real host console buttons work: the one that comes next moves the demo on.
  useEffect(() => {
    hooks.hostAction = (action, data, reply) => {
      if (action === 'video_control') {
        sockets.screen.dispatch('video_control', { action: data?.action, at: Date.now() })
        return reply({ success: true })
      }
      const next = steps[current.current + 1]
      if (next?.press === action) {
        reply(next.ack != null ? payload(next.ack) : { success: true })
        go(current.current + 1)
      } else {
        reply({ error: next?.label ? `In this demo, press "${next.label}" to carry on` : 'In this demo, press Next to carry on' })
      }
    }
  }, [go])

  // Scripted clicks for this step, and the marker on the button that comes next.
  useEffect(() => {
    let live = true
    const isCurrent = () => live
    for (const [device, ops] of Object.entries(step.drive ?? {})) drive(device as Device, ops as any[], isCurrent)
    const host = sockets.host.root
    const label = steps[index + 1]?.label
    const mark = setTimeout(() => {
      host?.querySelectorAll('[data-demo-press]').forEach(b => b.removeAttribute('data-demo-press'))
      if (host && label) findButton(host, label)?.setAttribute('data-demo-press', '')
    }, 160)
    return () => { live = false; clearTimeout(mark) }
  }, [index, step, keys])

  useEffect(() => {
    if (!playing) return
    if (index >= steps.length - 1) { setPlaying(false); return }
    const t = setTimeout(() => go(index + 1), dwell(step))
    return () => clearTimeout(t)
  }, [playing, index, step, go])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return
      if (e.key === 'ArrowRight') go(current.current + 1)
      else if (e.key === 'ArrowLeft') go(current.current - 1)
      else if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); setPlaying(p => !p) }
    }
    // Links on the staff pages lead to pages outside the demo.
    const onClick = (e: MouseEvent) => { if ((e.target as HTMLElement).closest?.('.d-device a[href]')) e.preventDefault() }
    window.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick, true)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick, true) }
  }, [go])

  const fixedScreens: string[] | undefined = step.show
  const isStatic = !!step.static
  const names = PLAYERS[step.game] ?? PLAYERS.main
  const next = steps[index + 1]
  const chapter = CHAPTERS[step.chapter]
  const shown = (d: string) => {
    if (isStatic || view === 'all') return fixedScreens ? fixedScreens.includes(d) : ['screen', 'host', 'p1', 'p2', 'p3'].includes(d)
    if (view === 'phones') return ['p1', 'p2', 'p3'].includes(d)
    return view === d
  }
  const layout = isStatic ? 'one' : view === 'all' ? (fixedScreens ? 'row' : 'all') : view === 'phones' ? 'phones' : 'one'

  const grouped = useMemo(() => CHAPTER_IDS.map(id => ({ id, items: steps.map((s: any, i: number) => ({ s, i })).filter(({ s }: any) => s.chapter === id) })), [])
  const railRef = useRef<HTMLElement>(null)
  useEffect(() => { railRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' }) }, [index, openChapter])
  const expanded = openChapter ?? step.chapter

  const slot = (d: Device, label: string, detail: string, size: { w: number; h: number; fill?: boolean }, page: ReactNode, staffChrome = false) => (
    <Screen key={d} id={d} label={label} detail={detail} size={size} hidden={!shown(d)} mount={keys[d] ?? 0} staffChrome={staffChrome}
      canFocus={!isStatic && view === 'all' && !d.startsWith('staff')} onFocus={() => setView(d.startsWith('p') ? 'phones' : d as View)}>
      {page}
    </Screen>
  )

  return (
    <div className="d-app">
      <aside className="d-rail" aria-label="Steps">
        <div className="d-brand">
          <span className="d-brand-name">Movie Quiz</span>
          <span className="d-brand-tag">Demo of every round and screen</span>
        </div>
        <nav className="d-chapters" ref={railRef}>
          {grouped.map(({ id, items }) => (
            <section key={id} className={`d-chapter${id === step.chapter ? ' here' : ''}`}>
              <button className="d-chapter-head" aria-expanded={expanded === id} onClick={() => setOpenChapter(expanded === id ? '' : id)}>
                <span className="d-chapter-name">{CHAPTERS[id].name}</span>
                <span className="d-chapter-kind">{CHAPTERS[id].kind}</span>
              </button>
              {expanded === id && (
                <ol>
                  {items.map(({ s, i }: any) => (
                    <li key={i}>
                      <button aria-current={i === index ? 'step' : undefined} onClick={() => { setPlaying(false); go(i) }}>
                        <span className="d-num">{i + 1}</span>{s.title}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </nav>
        <p className="d-rail-note">Runs on a recording of the real game engine. Questions, players and tickets are made up, and the pictures and clips are placeholders. Nothing here connects to the live system.</p>
      </aside>

      <main className="d-main">
        <header className="d-head">
          <div className="d-caption">
            <p className="d-eyebrow">{chapter.name} <span>{chapter.kind}</span></p>
            <h1>{step.title}</h1>
            <p className="d-body">{step.body}</p>
          </div>
          <div className="d-views" role="tablist" aria-label="Screens to show" hidden={isStatic}>
            {VIEWS.map(v => (
              <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>{v.label}</button>
            ))}
          </div>
        </header>

        <div className={`d-stage d-layout-${layout}`}>
          {slot('screen', 'Projector', 'What the room sees', SIZES.screen, <BigScreen />)}
          {slot('host', 'Host console', 'Coordinator', view === 'host' ? SIZES.hostFull : SIZES.host, <HostConsole />)}
          {slot('monitor', 'Live monitor', 'Volunteers', view === 'monitor' ? SIZES.hostFull : SIZES.host, <MonitorPage />)}
          <div className="d-phones" hidden={!['p1', 'p2', 'p3'].some(shown)}>
            {(['p1', 'p2', 'p3'] as const).map(d => slot(d, step.static ? 'Phone' : `${names[d]}'s phone`, '', SIZES.phone, <ParticipantView />))}
          </div>
          {step.staff !== undefined && !fixedScreens?.includes('staffPhone') && slot('staff', staffName(step.staff.role), 'Laptop', SIZES.staff, step.staff.role ? <Admin /> : <HostConsole />, true)}
          {fixedScreens?.includes('staffPhone') && slot('staffPhone', 'Volunteer', 'Phone', SIZES.phone, <Admin />, true)}
        </div>

        <footer className="d-transport">
          <button className="d-btn" onClick={() => { setPlaying(false); go(index - 1) }} disabled={index === 0} aria-label="Previous step">←</button>
          <button className="d-btn d-play" onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
          <button className="d-btn d-next" onClick={() => { setPlaying(false); go(index + 1) }} disabled={!next}>Next →</button>
          <div className="d-progress" aria-hidden="true"><span style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
          <span className="d-count">{index + 1} / {steps.length}</span>
          <select className="d-jump" aria-label="Jump to a part of the demo" value={step.chapter} onChange={e => go(steps.findIndex((s: any) => s.chapter === e.target.value))}>
            {CHAPTER_IDS.map(id => <option key={id} value={id}>{CHAPTERS[id].name}</option>)}
          </select>
          <span className="d-hint">
            {next?.label ? <>Next the coordinator presses <strong>{next.label}</strong>. It's marked on the host console, and you can click it there.</> : 'Use the arrow keys to step, and Space to play.'}
          </span>
        </footer>
      </main>
    </div>
  )
}

const staffName = (role: Role | null) => (role ? { admin: 'Admin', quizmaster: 'Quiz master', coordinator: 'Coordinator', volunteer: 'Volunteer' }[role] : 'Sign-in page')

function MonitorPage() {
  return (
    <div className="stage" data-staff>
      <main className="admin-main"><LiveMonitor /></main>
    </div>
  )
}

// One screen on the page: a box of the real size, scaled to fit its slot.
function Screen({ id, label, detail, size, hidden, mount, children, canFocus, onFocus, staffChrome }: {
  id: Device; label: string; detail: string; size: { w: number; h: number; fill?: boolean }; hidden: boolean; mount: number; children: ReactNode;
  canFocus: boolean; onFocus: () => void; staffChrome: boolean;
}) {
  const box = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ scale: 0.3, w: size.w, h: size.h || size.w })

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      if (!width || !height) return
      const scale = size.fill ? width / size.w : Math.min(width / size.w, height / size.h)
      setFit({ scale, w: size.w, h: size.fill ? height / scale : size.h })
    }
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [size.w, size.h, size.fill, hidden])

  const phone = id.startsWith('p') || id === 'staffPhone'
  const inner = (
    <ScreenSocket socket={sockets[id]}>
      <div className="d-scroll" ref={el => { sockets[id].root = el?.firstElementChild as HTMLElement ?? el }} key={mount}>
        <div className="d-page">{children}</div>
      </div>
    </ScreenSocket>
  )
  return (
    <figure className={`d-screen d-screen-${id}${phone ? ' d-is-phone' : ''}${staffChrome ? ' d-is-staff' : ''}`} hidden={hidden}>
      <figcaption>
        {canFocus ? <button onClick={onFocus}>{label}</button> : <span>{label}</span>}
        {detail && <em>{detail}</em>}
      </figcaption>
      <div className="d-box" ref={box}>
        <div className="d-frame" style={{ width: fit.w * fit.scale, height: fit.h * fit.scale }}>
          <div className="d-device" style={{ width: fit.w, height: fit.h, transform: `scale(${fit.scale})` }}>
            {inner}
            <canvas className="d-confetti" data-confetti={id} />
          </div>
        </div>
      </div>
    </figure>
  )
}
