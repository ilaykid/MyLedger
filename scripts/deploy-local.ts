/** Build an immutable local runtime separate from the assistant-writable repo. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('This deployment helper currently targets Windows.');
const local = process.env.LOCALAPPDATA;
if (!local) throw new Error('LOCALAPPDATA is not set');

const source = process.cwd();
const root = path.join(local, 'MyLedger');
const app = path.join(root, 'app');
const data = path.join(root, 'data');
mkdirSync(app, { recursive: true });
mkdirSync(data, { recursive: true });

for (const name of ['dist', 'src', 'scripts', 'prisma', 'node_modules', 'web']) {
  const from = path.join(source, name);
  if (!existsSync(from)) continue;
  if (name === 'prisma') {
    mkdirSync(path.join(app, name), { recursive: true });
    cpSync(path.join(from, 'schema.prisma'), path.join(app, name, 'schema.prisma'), { force: true });
    cpSync(path.join(from, 'migrations'), path.join(app, name, 'migrations'), { recursive: true, force: true });
  } else if (name === 'web') {
    mkdirSync(path.join(app, 'web'), { recursive: true });
    cpSync(path.join(from, 'dist'), path.join(app, 'web', 'dist'), { recursive: true, force: true });
  } else {
    cpSync(from, path.join(app, name), { recursive: true, force: true });
  }
}
for (const name of ['package.json', 'package-lock.json']) cpSync(path.join(source, name), path.join(app, name), { force: true });

// First deployment seeds the protected data directory. Later deployments only
// replace code: the runtime database is authoritative and must never be reset
// from a stale development copy.
const runtimeDb = path.join(data, 'myledger.db');
if (!existsSync(runtimeDb)) {
  cpSync(path.join(source, 'prisma', 'myledger.db'), runtimeDb, { force: false });
  for (const name of ['accounts.config.json', 'backup.config.json']) {
    const from = path.join(source, name);
    if (existsSync(from)) cpSync(from, path.join(data, name), { force: false });
  }
  const profiles = path.join(source, '.browser-profiles');
  if (existsSync(profiles)) cpSync(profiles, path.join(data, '.browser-profiles'), { recursive: true, force: false });
}

const sourceEnv = existsSync(path.join(source, '.env')) ? readFileSync(path.join(source, '.env'), 'utf8') : '';
const dbUrl = `file:${runtimeDb.replace(/\\/g, '/')}`;
const filtered = sourceEnv
  .split(/\r?\n/)
  .filter((line) => !/^(DATABASE_URL|MYLEDGER_(?:APP|DATA)_DIR)=/.test(line));
writeFileSync(path.join(data, '.env'), [
  `DATABASE_URL="${dbUrl}"`,
  `MYLEDGER_APP_DIR="${app}"`,
  `MYLEDGER_DATA_DIR="${data}"`,
  ...filtered,
].join('\r\n'), 'utf8');

const envLines = [
  `set "MYLEDGER_APP_DIR=${app}"`,
  `set "MYLEDGER_DATA_DIR=${data}"`,
  `set "DATABASE_URL=${dbUrl}"`,
];
const tsx = path.join(app, 'node_modules', 'tsx', 'dist', 'cli.mjs');
writeFileSync(path.join(data, 'api.cmd'), [
  '@echo off', ...envLines, `cd /d "${data}"`, ':loop',
  `node "${path.join(app, 'dist', 'server', 'index.js')}" >> api.log 2>&1`,
  'if "%ERRORLEVEL%"=="3" goto done', 'timeout /t 30 /nobreak > nul', 'goto loop', ':done', '',
].join('\r\n'), 'utf8');
writeFileSync(path.join(data, 'nightly.cmd'), [
  '@echo off', ...envLines, `cd /d "${data}"`,
  `node "${tsx}" "${path.join(app, 'scripts', 'rotate-logs.ts')}" > nul 2>&1`,
  `node "${tsx}" "${path.join(app, 'src', 'index.ts')}" >> nightly.log 2>&1`,
  `if exist backup.config.json node "${tsx}" "${path.join(app, 'scripts', 'backup.ts')}" >> nightly.log 2>&1`,
  `node "${tsx}" "${path.join(app, 'src', 'notify-cli.ts')}" >> nightly.log 2>&1`, '',
].join('\r\n'), 'utf8');
writeFileSync(path.join(data, 'api-hidden.vbs'), `CreateObject("WScript.Shell").Run """${path.join(data, 'api.cmd')}""", 0, False\r\n`, 'utf8');

// Use SIDs so this works on Hebrew and English Windows alike.
const who = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
const userSid = /"[^"]+","([^"]+)"/.exec(who)?.[1];
if (!userSid) throw new Error('Could not determine the current Windows SID');
execFileSync('icacls', [root, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore' });
// Never apply inheritance-only flags directly to files: Windows creates an
// empty effective DACL and locks even the owner out. Reset children afterwards
// so they inherit the already-protected root ACL (validated on a throwaway tree).
execFileSync('icacls', [path.join(root, '*'), '/reset', '/T', '/C'], { stdio: 'ignore' });

console.log(`✓ Protected app:  ${app}`);
console.log(`✓ Protected data: ${data}`);
console.log('  Run schedule:install again to point Windows at this runtime.');
