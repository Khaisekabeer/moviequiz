import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import path from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = 3001

const portInUse = (port: number) => new Promise<boolean>(done => {
  const socket = connect({ port, host: '127.0.0.1' })
  socket.once('connect', () => { socket.destroy(); done(true) })
  socket.once('error', () => done(false))
})

// Dev only: the pages call the admin API on :3001, and on a laptop nothing else serves it. On Vercel
// the API is part of the deployment. A backend already running (npm start, npm run game) is left alone.
const startBackend = (): Plugin => ({
  name: 'start-backend',
  apply: 'serve',
  async configureServer() {
    if (await portInUse(API_PORT)) return
    const backend = spawn(process.execPath, ['server.js'], { cwd: path.resolve(process.cwd(), '../backend'), stdio: 'inherit' })
    backend.on('error', err => console.error(`Could not start the backend: ${err.message}`))
    process.once('exit', () => backend.kill())
  },
})

// SPA fallback for Apache: unknown paths under the base serve index.html so refreshing /moviequiz/admin works.
const htaccess = (base: string): Plugin => ({
  name: 'apache-htaccess',
  apply: 'build',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: '.htaccess',
      source: [
        'Options -Indexes',
        '<IfModule mod_rewrite.c>',
        'RewriteEngine On',
        `RewriteBase ${base}`,
        'RewriteRule ^index\\.html$ - [L]',
        'RewriteCond %{REQUEST_FILENAME} !-f',
        'RewriteCond %{REQUEST_FILENAME} !-d',
        'RewriteRule . index.html [L]',
        '</IfModule>',
        '<IfModule mod_headers.c>',
        '<FilesMatch "^index\\.html$">',
        'Header set Cache-Control "no-cache"',
        '</FilesMatch>',
        '<FilesMatch "\\.(js|css|woff2?)$">',
        'Header set Cache-Control "public, max-age=31536000, immutable"',
        '</FilesMatch>',
        '</IfModule>',
        '',
      ].join('\n'),
    })
  },
})

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const apache = mode === 'apache'

  if (apache && !/^https:\/\//.test(env.VITE_API_BASE || '')) {
    throw new Error('Apache build: set VITE_API_BASE to the Vercel address (https://...) in frontend/.env.apache')
  }
  const base = apache ? env.VITE_BASE_PATH || '/moviequiz/' : '/'

  return {
    base,
    plugins: [react(), startBackend(), apache && htaccess(base)],
    server: {
      host: true,
      port: 5173,
    },
  }
})
