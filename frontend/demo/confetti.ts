// Replaces canvas-confetti in the demo, so a phone's confetti stays on that phone.
import real from '../node_modules/canvas-confetti/dist/confetti.module.mjs'
import { active } from './runtime'

const fired = new Map<HTMLCanvasElement, (options: any) => void>()

export default function confetti(options: any) {
  const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-confetti="${active.device}"]`)
  if (!canvas || canvas.offsetParent === null) return // that screen is not showing
  if (!fired.has(canvas)) fired.set(canvas, (real as any).create(canvas, { resize: true, useWorker: false, disableForReducedMotion: true }))
  fired.get(canvas)!(options)
}
