// Builds the demo: records both games on the real engine, bundles the real pages, and writes one
// self-contained HTML file. Run from frontend/: npm run demo
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const demo = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(demo, 'dist')

execFileSync(process.execPath, ['demo-record.js'], { cwd: path.join(demo, '..', '..', 'backend'), stdio: ['ignore', 'ignore', 'inherit'] })
await build({ configFile: path.join(demo, 'vite.config.ts'), logLevel: 'warn' })

const assets = path.join(out, 'build', 'assets')
const pick = ext => fs.readFileSync(path.join(assets, fs.readdirSync(assets).find(f => f.endsWith(ext))), 'utf8')
// Neither can close its own tag early.
const css = pick('.css').replace(/<\/style/gi, '<\\/style')
const js = pick('.js').replace(/<\/script/gi, '<\\/script')

fs.writeFileSync(path.join(out, 'moviequiz-demo.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Movie Quiz Demo</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${js}</script>
</body>
</html>
`)
fs.rmSync(path.join(out, 'build'), { recursive: true })

const size = fs.statSync(path.join(out, 'moviequiz-demo.html')).size
console.log(`Demo: ${path.relative(process.cwd(), path.join(out, 'moviequiz-demo.html'))} (${(size / 1048576).toFixed(1)} MB). Open it in a browser.`)
