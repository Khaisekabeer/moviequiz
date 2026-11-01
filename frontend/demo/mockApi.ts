// Sample answers for the staff pages, which have no live game behind them. The people and questions
// are the ones in the recording; saving anything here changes nothing.
import { bank, people } from './runtime'

const DAY = '2026-11-07'
const minutes = (i: number) => `${DAY}T${String(9 + Math.floor(i / 4)).padStart(2, '0')}:${String(12 + (i % 4) * 11).padStart(2, '0')}:00.000Z`

// The first 24 are admitted; the last two are still to arrive, so a scan finds someone new.
const registrations = people.map((p: any, i: number) => ({ ...p, checkedInAt: i < 24 ? minutes(i) : null, checkedInBy: i < 24 ? 'Volunteer' : null }))

const levels = bank.levels.map((l: any) => ({
  number: l.level, name: l.levelName, multiplier: l.multiplier, theme: l.theme, mode: l.mode, cut: l.cut, isActive: true,
  afterMiss: l.afterMiss ?? 'next', untimed: !!l.untimed, answerSeconds: l.answerSeconds ?? 10, resetScores: false, scoring: null, manualResults: !!l.manualResults,
}))
const questions = bank.questions.map((q: any, i: number) => ({
  id: q.id, level: q.level, position: i, text: q.text, type: q.type, accepted: q.accepted ?? '', options: q.options, correctAnswer: q.correctAnswer,
  timeLimit: q.timeLimit, points: q.points, isActive: true, note: q.note ?? '', imageId: q.image ? 'drawing' : null,
  videoId: q.video ? 'clip' : null, clipKind: q.video ? q.video.mime.split('/')[0] : null,
}))
const staff = [
  ['s1', 'admin', 'Festival Admin', 'admin'],
  ['s2', 'quizmaster', 'Quiz Master', 'quizmaster'],
  ['s3', 'coordinator', 'Coordinator', 'coordinator'],
  ['s4', 'volunteer1', 'Volunteer One', 'volunteer'],
  ['s5', 'volunteer2', 'Volunteer Two', 'volunteer'],
].map(([id, username, displayName, role]) => ({ id, username, displayName, role, active: true, hasPin: false }))

const mainSet = { id: 'main', name: 'Main set' }
const until = () => Date.now() + 29 * 60 * 1000
export const openSet = { on: false }

const recent = () => registrations.filter((r: any) => r.checkedInAt).slice(0, 12).reverse().map((r: any, i: number) => ({
  id: i, action: 'admit', at: r.checkedInAt, ticketId: r.ticketId, name: r.name, college: r.college, by: r.checkedInBy,
}))

function respond(method: string, url: URL): [number, any] {
  const path = url.pathname.replace(/^\/api/, '')
  const ticket = path.match(/^\/checkin\/([^/]+)$/)?.[1]

  if (path === '/auth/login') return [401, { error: 'Sign-in is off in this demo. Press Next to carry on.' }]
  if (path === '/auth/forgot-password') return [200, { message: 'In the real page, a 6-digit code goes to this address.' }]
  if (path === '/auth/me') return [200, openSet.on ? { vaultUntil: until(), vaultBank: mainSet } : {}]
  if (path === '/banks') return [200, [
    { id: 'main', name: 'Main set', ready: true, questions: questions.length, active: questions.length, levels: levels.length },
    { id: 'trial', name: 'Trial set', ready: true, questions: 7, active: 7, levels: 4 },
  ]]
  if (path.endsWith('/open')) return [200, { vaultUntil: until(), bank: mainSet }]
  if (path === '/questions') return [200, questions]
  if (path === '/levels') return [200, levels]
  if (path === '/game/questions-status') return [200, { online: true, state: 'lobby', count: questions.length, by: 'Coordinator', bank: mainSet }]
  if (path === '/game/status') return [200, { online: true, state: 'lobby', count: questions.length, by: 'Coordinator', players: 0 }]
  if (path === '/settings') return [200, { gameServerUrl: 'https://game.vyuham.example', requireCheckin: true }]
  if (path === '/checkin/stats') return [200, { total: registrations.length, checkedIn: registrations.filter((r: any) => r.checkedInAt).length }]
  if (path === '/checkin/recent') return [200, recent()]
  if (path === '/results/games') return [200, []]
  if (path === '/staff') return [200, staff]
  if (path === '/registrations') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const status = url.searchParams.get('status')
    const rows = registrations.filter((r: any) => (!q || `${r.name} ${r.ticketId} ${r.email} ${r.college}`.toLowerCase().includes(q))
      && (status === 'all' || !status || (status === 'in') === !!r.checkedInAt))
    return [200, { rows, total: rows.length }]
  }
  if (ticket) {
    const reg = registrations.find((r: any) => r.ticketId === decodeURIComponent(ticket).toUpperCase())
    if (!reg) return [404, { error: 'Not found', ticketId: decodeURIComponent(ticket).toUpperCase() }]
    return [200, method === 'POST' ? { registration: { ...reg, checkedInAt: new Date().toISOString(), checkedInBy: 'Volunteer' } } : reg]
  }
  return [200, {}]
}

export async function mockFetch(input: string, init?: RequestInit) {
  const url = new URL(input, 'https://demo.invalid')
  if (url.pathname.includes('/questions/images/')) return new Response(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }))
  const [status, body] = respond(init?.method ?? 'GET', url)
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
