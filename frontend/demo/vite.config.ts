import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const demo = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(demo, '..')

const UNITS: Record<string, string> = { svh: 'cqh', dvh: 'cqh', lvh: 'cqh', vh: 'cqh', vw: 'cqw', vmax: 'cqmax', vmin: 'cqmin' }

// The demo shows every screen at once in one page, so a "viewport" is a box on the page. Viewport
// units and the one layout breakpoint in the app's code become container units here; the app's
// own build is not touched.
const screensInBoxes = (): Plugin => ({
  name: 'demo-screens-in-boxes',
  enforce: 'pre',
  transform(code, id) {
    const file = id.split('?')[0].replace(/\\/g, '/')
    // Each font has a woff2 and a woff; every browser this runs in takes the woff2.
    if (file.includes('@fontsource')) return code.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '')
    if (!file.startsWith(`${frontend.replace(/\\/g, '/')}/src/`)) return null
    return code
      .replace(/(\d*\.?\d+)(svh|dvh|lvh|vh|vw|vmax|vmin)\b/g, (_, n, unit) => `${n}${UNITS[unit]}`)
      .replace(/@media \(max-width: (\d+)px\)/g, '@container (max-width: $1px)')
  },
})

export default defineConfig({
  root: frontend,
  base: '/moviequiz/', // the address the projector shows, as on the event's Apache hosting
  publicDir: false,
  plugins: [screensInBoxes(), react()],
  resolve: {
    alias: [
      { find: /^.*\/contexts\/SocketContext$/, replacement: path.join(demo, 'SocketContext.tsx') },
      { find: /^.*\/hooks\/useCountdown$/, replacement: path.join(demo, 'useCountdown.ts') },
      { find: /^.*\/components\/QuestionPicture$/, replacement: path.join(demo, 'QuestionPicture.tsx') },
      { find: /^canvas-confetti$/, replacement: path.join(demo, 'confetti.ts') },
      { find: /^html5-qrcode$/, replacement: path.join(demo, 'noCamera.ts') },
    ],
  },
  define: {
    localStorage: 'globalThis.__demoStorage',
    sessionStorage: 'globalThis.__demoStorage',
    'window.location': 'globalThis.__demoLocation',
    'window.isSecureContext': 'true',
  },
  build: {
    outDir: path.join(demo, 'dist', 'build'),
    emptyOutDir: true,
    assetsInlineLimit: 1e9, // the page is one file
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1e6,
    rollupOptions: {
      input: path.join(demo, 'index.html'),
      output: { codeSplitting: false },
    },
  },
})
