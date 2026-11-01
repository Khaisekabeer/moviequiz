// Publishes the live game server (npm run game) over HTTPS with Cloudflare Tunnel.
//
//   npm run tunnel:quick                          rehearsals: no account needed, a temporary address
//   npm run tunnel:setup -- game.yourdomain.com   one-time: sign in, create the tunnel, route the hostname
//   npm run tunnel                                event day: run the tunnel made by tunnel:setup
require('dotenv').config({ quiet: true });
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TUNNEL_NAME = 'moviequiz';
const CONFIG = path.join(__dirname, 'cloudflared.yml');
const PORT = Number(process.env.GAME_PORT || process.env.PORT) || 3001;
const LOCAL = `http://localhost:${PORT}`;
const CLOUDFLARED_HOME = path.join(os.homedir(), '.cloudflared');

// On PATH after a normal install; otherwise the usual Windows locations.
function findCloudflared() {
  const onPath = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  if (!onPath.error) return 'cloudflared';
  const places = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  const found = places.find(p => fs.existsSync(p));
  if (found) return found;
  console.error('cloudflared is not installed. Install it with:\n  winget install --id Cloudflare.cloudflared -e');
  process.exit(1);
}

const cloudflared = findCloudflared();

function run(args, { capture = false } = {}) {
  const result = spawnSync(cloudflared, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`cloudflared ${args.join(' ')} failed${capture ? `:\n${result.stderr}` : ''}`);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

const findTunnel = () => JSON.parse(run(['tunnel', 'list', '--output', 'json'], { capture: true }) || '[]').find(t => t.name === TUNNEL_NAME);

function setup(hostname) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostname || '')) {
    console.error('Give the address players will reach, on a domain in your Cloudflare account:\n  npm run tunnel:setup -- game.yourdomain.com');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(CLOUDFLARED_HOME, 'cert.pem'))) {
    console.log('Opening the browser: pick the domain to authorise.');
    run(['tunnel', 'login']);
  }
  if (!findTunnel()) run(['tunnel', 'create', TUNNEL_NAME]);
  const { id } = findTunnel();
  run(['tunnel', 'route', 'dns', TUNNEL_NAME, hostname]);
  fs.writeFileSync(CONFIG, [
    `# Written by npm run tunnel:setup. Not committed: it names this machine's tunnel.`,
    `tunnel: ${id}`,
    `credentials-file: ${path.join(CLOUDFLARED_HOME, `${id}.json`)}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: ${LOCAL}`,
    '  - service: http_status:404',
    '',
  ].join('\n'));
  console.log(`\nTunnel "${TUNNEL_NAME}" is ready.`);
  console.log(`1. Admin → Overview → Live game server: https://${hostname}`);
  console.log('2. Event day, two terminals: npm run game, then npm run tunnel');
}

function runNamed() {
  if (!fs.existsSync(CONFIG)) {
    console.error('No tunnel set up yet. Run: npm run tunnel:setup -- game.yourdomain.com');
    process.exit(1);
  }
  console.log(`Publishing ${LOCAL}. Keep this window open.`);
  spawn(cloudflared, ['tunnel', '--config', CONFIG, 'run'], { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 0));
}

function runQuick() {
  const child = spawn(cloudflared, ['tunnel', '--url', LOCAL], { stdio: ['ignore', 'ignore', 'pipe'] });
  let shown = false;
  child.stderr.on('data', chunk => {
    const url = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (!url || shown) return;
    shown = true;
    console.log(`\nPublished at ${url}`);
    console.log('Paste it into Admin → Overview → Live game server. It changes every time you run this.');
    console.log('For rehearsals only: quick tunnels have no uptime guarantee and limit in-flight requests.\n');
  });
  child.on('exit', code => process.exit(code ?? 0));
}

const [command, hostname] = process.argv.slice(2);
if (command === 'setup') setup(hostname);
else if (command === 'quick') runQuick();
else runNamed();
