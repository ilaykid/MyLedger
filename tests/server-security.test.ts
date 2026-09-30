import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/client';

const root = mkdtempSync(path.join(tmpdir(), 'ledger-server-security-'));
const credential = 'synthetic-credential-do-not-return';
let child: ChildProcess | undefined;
let base: string;
before(async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DATABASE_URL: 'file:' + path.join(root, 'fixture.db').replaceAll('\\', '/'),
    MYLEDGER_DATA_DIR: root, MYLEDGER_APP_DIR: process.cwd(), DOTENV_CONFIG_PATH: path.join(root, '.env'),
    MYLEDGER_DEMO: '1', MYLEDGER_DEV_ORIGINS: '', API_PORT: String(port) };
  writeFileSync(path.join(root, 'fixture.db'), '');
  writeFileSync(path.join(root, 'accounts.config.json'), JSON.stringify({ accounts: [{ company: 'max', credentials: { username: credential, password: credential } }] }));
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try { await db.settings.create({ data: { id: 1, telegramToken: credential, telegramChatId: credential } }); }
  finally { await db.$disconnect(); }
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture API startup timed out')), 20000);
    child!.once('error', error => { clearTimeout(timeout); reject(error); });
    child!.once('exit', () => { clearTimeout(timeout); reject(new Error('Fixture API exited before readiness')); });
    child!.stdout!.on('data', data => { if (String(data).includes('API listening')) { clearTimeout(timeout); resolve(); } });
  });
});
after(async () => {
  if (child && child.exitCode === null) await new Promise<void>(resolve => { child!.once('exit', () => resolve()); child!.kill(); });
  rmSync(root, { recursive: true, force: true });
});

test('production routes keep credentials write-only and protect financial responses from caching', async () => {
  for (const route of ['/api/settings', '/api/connections']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.text()).includes(credential), false);
  }
  for (const route of ['/accounts.config.json', '/.env', '/prisma/myledger.db', '/../accounts.config.json', '/%2e%2e/accounts.config.json']) {
    const response = await fetch(base + route);
    assert.equal((await response.text()).includes(credential), false);
  }
});

test('demo mode blocks all tested provider, notification and backup writes before side effects', async () => {
  for (const [method, route] of [
    ['POST', '/api/scrape'], ['POST', '/%61pi/scrape'], ['POST', '/api/connections'],
    ['DELETE', '/api/connections/max'], ['PUT', '/api/telegram'], ['POST', '/api/telegram/test'],
    ['POST', '/api/telegram/detect-chat'], ['POST', '/api/telegram/recipients/test'], ['POST', '/api/backup/prepare'],
  ]) {
    const response = await fetch(base + route, { method, headers: { 'x-myledger': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403, route);
  }
});

test('actual API rejects CSRF and returns controlled validation errors', async () => {
  assert.equal((await fetch(base + '/api/categories', { method: 'POST' })).status, 403);
  const response = await fetch(base + '/api/categories', { method: 'POST', headers: { 'x-myledger': '1', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, 'validation');
});
