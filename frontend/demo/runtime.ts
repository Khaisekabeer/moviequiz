// The stand-in for the game server: one socket per screen, fed from the recording.
import recording from './recording.json'
import chime from './clips/chime.wav'
import lifeboat from './clips/lifeboat.webm'

export const { steps, bank, people } = recording as any
export const payload = (ref: number) => JSON.parse((recording as any).pool[ref])

const CLIPS: Record<string, string> = { audio: chime, video: lifeboat }

// Which screen is handling an event, so its confetti lands on that screen.
export const active = { device: 'screen' }

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

export const hooks = {
  hostAction: (_action: string, _data: any, _reply: (r: any) => void) => {},
}

export class DemoSocket {
  id: string
  connected = true
  snap: any = null        // what this screen gets when it opens (a list of events, or a phone's seat)
  ack: any = null         // the answer to the next join attempt
  root: HTMLElement | null = null
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  private run = 0

  constructor(id: string) { this.id = id }

  on(event: string, fn: (...args: any[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return this
  }

  off(event: string, fn?: (...args: any[]) => void) {
    if (fn) this.listeners.get(event)?.delete(fn)
    else this.listeners.delete(event)
    return this
  }

  connect() { return this }

  dispatch(event: string, value: any) {
    if (event === 'game_state' && value?.video) value.video = { ...value.video, url: CLIPS[value.video.url] ?? value.video.url }
    const previous = active.device
    active.device = this.id
    this.listeners.get(event)?.forEach(fn => fn(value))
    active.device = previous
  }

  // What the page sends to the server.
  emit(event: string, ...args: any[]) {
    const reply = typeof args[args.length - 1] === 'function' ? args.pop() : () => {}
    if (event === 'join_role') {
      reply({ success: true })
      for (const [name, ref] of this.snap ?? []) this.dispatch(name, payload(ref))
    } else if (event === 'rejoin_game') {
      reply(this.snap != null ? payload(this.snap) : { error: 'Session not found' })
    } else if (event === 'join_game') {
      reply(this.ack ?? { error: 'Players join in the demo when you press Next.' })
    } else if (event === 'host_action') {
      hooks.hostAction(args[0], args[1], reply)
    } else if (event === 'video_status') {
      sockets.host.dispatch('video_status', args[0])
      reply({ success: true })
    } else {
      reply({ success: true })
    }
    return this
  }

  // A step's events, in order. A tap is a real click on the phone's option, once it has rendered.
  async play(events: [string, number][]) {
    const run = ++this.run
    for (const [event, ref] of events) {
      if (event === '__tap') {
        await wait(60)
        if (run !== this.run) return
        const label = payload(ref)
        const option = [...(this.root?.querySelectorAll<HTMLButtonElement>('.opt-btn') ?? [])].find(b => b.querySelector('.opt-text')?.textContent === label)
        option?.click()
      } else {
        this.dispatch(event, payload(ref))
      }
    }
  }

  cancel() { this.run++ }
}

export const DEVICES = ['screen', 'host', 'monitor', 'p1', 'p2', 'p3', 'staff', 'staffPhone'] as const
export type Device = typeof DEVICES[number]
export const sockets = Object.fromEntries(DEVICES.map(id => [id, new DemoSocket(id)])) as Record<Device, DemoSocket>
