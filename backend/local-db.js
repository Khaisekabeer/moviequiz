// Local Supabase in Docker, for running the whole event on one laptop.
//
//   npm run db:start    start it (first time: downloads images, applies migrations), write backend/.env
//   npm run db:stop     stop it; the data stays
//   npm run db:reset    WIPE everything and reapply the migrations
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(__dirname, '.env');
// Only what the quiz uses: the database, its REST API and file storage.
const SKIP = 'realtime,edge-runtime,imgproxy,logflare,vector,mailpit,studio,postgres-meta';

function supabase(args, capture = false) {
  const result = spawnSync('npx', ['supabase', ...args, '--workdir', ROOT], { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', shell: true });
  if (result.status !== 0) {
    console.error(`supabase ${args[0]} failed. Check that Docker Desktop is running and ports 56320-56329 are free.${capture ? `\n${result.stderr}` : ''}`);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

// Fills in what's missing and never changes a value that is already set: a new
// QUESTION_VAULT_SECRET would make existing question sets unreadable.
function writeEnv() {
  const status = Object.fromEntries(supabase(['status', '-o', 'env'], true).split(/\r?\n/)
    .map(line => line.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map(m => [m[1], m[2]]));
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const has = key => new RegExp(`^${key}=.+`, 'm').test(current);
  const adminPassword = crypto.randomBytes(9).toString('base64url');
  const wanted = {
    SUPABASE_URL: status.API_URL,
    SUPABASE_SECRET_KEY: status.SECRET_KEY || status.SERVICE_ROLE_KEY,
    QUESTION_VAULT_SECRET: crypto.randomBytes(32).toString('base64'),
    GAME_LINK_SECRET: crypto.randomBytes(32).toString('base64url'),
    ADMIN_PASSWORD: adminPassword,
    PORT: '3001',
  };
  const added = Object.entries(wanted).filter(([key]) => !has(key));
  if (added.length) {
    const kept = current.split(/\r?\n/).filter(line => line && !added.some(([key]) => line.startsWith(`${key}=`)));
    fs.writeFileSync(ENV_FILE, [...kept, ...added.map(([key, value]) => `${key}=${value}`), ''].join('\n'));
    console.log(`Wrote ${added.map(([key]) => key).join(', ')} to backend/.env`);
  }
  if (added.some(([key]) => key === 'ADMIN_PASSWORD')) console.log(`First sign-in: admin / ${adminPassword}`);
  if (added.some(([key]) => key === 'QUESTION_VAULT_SECRET')) console.log('Back up QUESTION_VAULT_SECRET: without it question sets cannot be decrypted.');
}

const command = process.argv[2];
if (command === 'start') {
  supabase(['start', '-x', SKIP]);
  writeEnv();
  console.log('Local Supabase is ready. Next: npm start');
} else if (command === 'stop') {
  supabase(['stop']);
} else if (command === 'reset') {
  supabase(['db', 'reset']);
} else {
  console.error('Use: node local-db.js start | stop | reset');
  process.exit(1);
}
