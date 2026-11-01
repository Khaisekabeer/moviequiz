// Runs before any page loads. Every screen shares this one document, so what a browser would keep
// per tab is kept here, and nothing the demo does reaches real storage or the network.
import logo from '../public/vyuham-logo.png?inline'
import logoWhite from '../public/vyuham-logo-white.png?inline'
import { mockFetch } from './mockApi'

const memory = new Map<string, string>()

;(globalThis as any).__demoStorage = {
  // Every phone tries to take its seat back; the socket answers for the player on that phone.
  getItem: (key: string) => (key === 'vyuham_player_token' ? 'demo' : memory.get(key) ?? null),
  setItem: (key: string, value: string) => { memory.set(key, value) },
  removeItem: (key: string) => { memory.delete(key) },
}
;(globalThis as any).__demoLocation = { hostname: 'vyuham.duk.ac.in', host: 'vyuham.duk.ac.in', port: '', protocol: 'https:', origin: 'https://vyuham.duk.ac.in' }

window.fetch = mockFetch as typeof fetch
// The viewer has no dialogs, and the page's confirmations would stop a click from doing anything.
window.confirm = () => true
window.prompt = (_message, value) => value ?? ''
window.alert = () => {}

navigator.vibrate = () => false

// The pages load the logo from the site's root; here it is part of the file. React sets an image
// both ways: the attribute when it creates it, then the property when it mounts.
const embedded = (value: unknown) => {
  const logoFile = String(value).match(/vyuham-logo(-white)?\.png$/)
  return logoFile ? (logoFile[1] ? logoWhite : logo) : value
}
const setAttribute = Element.prototype.setAttribute
Element.prototype.setAttribute = function (name: string, value: string) {
  setAttribute.call(this, name, name === 'src' ? embedded(value) as string : value)
}
const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value) { src.set!.call(this, embedded(value)) } })
