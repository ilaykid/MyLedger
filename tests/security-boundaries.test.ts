import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { packBundle, unpackBundle, restoreBundle, encryptBundle, decryptBundle } from '../src/backup.js';
import { fetchLocalModel, localModelUrl } from '../src/local-fetch.js';
import { assessDependencyAudit } from '../src/dependency-audit.js';
import { registerHttpSecurity } from '../src/server/security.js';
import { compileSafeRegex } from '../src/safe-regex.js';
import { redactSecrets } from '../src/redact.js';

function rawBundle(files: unknown[], data = Buffer.alloc(0)) {
  const header = Buffer.from(JSON.stringify({ createdAt: '2026-09-30', files }));
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, data]);
}

test('backup rejects traversal, Windows streams, duplicate names and malformed sizes', () => {
  for (const name of ['../escape', '..\\escape', '/escape', 'C:\\escape', 'myledger.db:payload', 'CON', 'nested/myledger.db']) {
    assert.throws(() => unpackBundle(rawBundle([{ name, size: 0 }])));
  }
  for (const size of [-1, 0.5, '1', null, 1e20]) assert.throws(() => unpackBundle(rawBundle([{ name: 'myledger.db', size }])));
  assert.throws(() => unpackBundle(rawBundle([{ name: 'myledger.db', size: 0 }, { name: 'myledger.db', size: 0 }])));
  assert.throws(() => unpackBundle(rawBundle([{ name: 'myledger.db', size: 0 }], Buffer.from('hidden'))));
  assert.throws(() => unpackBundle(rawBundle([{ name: 'myledger.db', size: 10 }])));
});

test('restore round trip works and refuses an existing destination before overwriting', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ledger-backup-test-'));
  try {
    const data = Buffer.from('synthetic database');
    const packed = packBundle([{ name: 'myledger.db', data }]);
    const encrypted = encryptBundle(packed, 'test passphrase');
    const opened = decryptBundle(encrypted, 'test passphrase');
    assert.throws(() => decryptBundle(encrypted, 'wrong passphrase'));
    const modified = Buffer.from(encrypted); modified[modified.length - 1] ^= 1;
    assert.throws(() => decryptBundle(modified, 'test passphrase'));
    const target = path.join(root, 'restored');
    restoreBundle(opened, target);
    assert.deepEqual(readFileSync(path.join(target, 'myledger.db')), data);
    assert.throws(() => restoreBundle(packBundle([{ name: 'myledger.db', data: Buffer.from('replacement') }]), target));
    assert.deepEqual(readFileSync(path.join(target, 'myledger.db')), data);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local model rejects remote origins and credential-bearing or ambiguous URLs', () => {
  for (const base of ['https://example.invalid', 'http://127.0.0.1.example.invalid', 'file:///localhost', 'http://user:pass@localhost', 'http://localhost/api?remote=x', 'http://localhost/#x']) {
    assert.throws(() => localModelUrl(base, '/api/chat'));
  }
  assert.equal(localModelUrl('http://localhost:11434', '/api/chat').hostname, '127.0.0.1');
  assert.equal(localModelUrl('http://[::1]:11434', '/api/chat').hostname, '[::1]');
});

test('local model refuses redirects before forwarding a sensitive POST body', async () => {
  let leaked = 0;
  const receiver = createServer((_req, res) => { leaked++; res.end('{}'); });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = (receiver.address() as { port: number }).port;
  const redirector = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${receiverPort}/sink` }); res.end(); });
  await new Promise<void>(resolve => redirector.listen(0, '127.0.0.1', resolve));
  try {
    const port = (redirector.address() as { port: number }).port;
    await assert.rejects(fetchLocalModel(`http://127.0.0.1:${port}`, '/api/chat', { method: 'POST', body: 'synthetic merchant', signal: AbortSignal.timeout(3000) }));
    assert.equal(leaked, 0);
  } finally {
    await Promise.all([new Promise<void>(resolve => redirector.close(() => resolve())), new Promise<void>(resolve => receiver.close(() => resolve()))]);
  }
});

test('audit errors and incomplete responses cannot become a clean report', () => {
  for (const report of [null, {}, { error: {}, vulnerabilities: {} }, { vulnerabilities: {} }, { metadata: { vulnerabilities: { total: 1 } }, vulnerabilities: {} }]) {
    assert.throws(() => assessDependencyAudit(report));
  }
  assert.deepEqual(assessDependencyAudit({ metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} }), { unexpected: [] });
});

test('previously excepted advisories and new advisories all fail review', () => {
  const via = [{ name: 'extract-zip', severity: 'high', url: 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv' }];
  const report = { metadata: { vulnerabilities: { total: 1 } }, vulnerabilities: { 'extract-zip': { via } } };
  assert.equal(assessDependencyAudit(report).unexpected.length, 1);
  via.push({ name: 'extract-zip', severity: 'high', url: 'https://example.invalid/new-advisory' });
  assert.equal(assessDependencyAudit(report).unexpected.length, 2);
});

test('HTTP guards block rebinding and encoded-path CSRF, preserve valid local requests and forbid caching', async () => {
  const app = Fastify(); registerHttpSecurity(app);
  app.get('/api/data', () => ({ financial: 'synthetic' }));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) app.route({ method, url: '/api/data', handler: () => ({ ok: true }) });
  try {
    assert.equal((await app.inject({ url: '/api/data', headers: { host: 'attacker.invalid' } })).statusCode, 421);
    assert.equal((await app.inject({ url: '/api/data', headers: { host: 'localhost.attacker.invalid' } })).statusCode, 421);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/api/data', '/%61pi/data', '/api%2fdata', '/unrelated']) {
        assert.equal((await app.inject({ method, url, headers: { host: 'localhost' } })).statusCode, 403);
      }
      assert.equal((await app.inject({ method, url: '/api/data', headers: { host: 'localhost', 'x-myledger': '1' } })).statusCode, 200);
    }
    const read = await app.inject({ url: '/api/data', headers: { host: '127.0.0.1', origin: 'https://attacker.invalid' } });
    assert.equal(read.headers['access-control-allow-origin'], undefined);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(read.headers['x-frame-options'], 'DENY');
    assert.equal(read.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(String(read.headers['content-security-policy']), /frame-ancestors 'none'/);
  } finally { await app.close(); }
});

test('Host checks still execute before a development CORS preflight', async () => {
  const app = Fastify(); registerHttpSecurity(app);
  await app.register(cors, { origin: ['http://localhost:5173'] });
  try {
    assert.equal((await app.inject({ method: 'OPTIONS', url: '/api/data', headers: { host: 'attacker.invalid', origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } })).statusCode, 421);
  } finally { await app.close(); }
});

test('ambiguous and nested regex bypasses are rejected before execution', () => {
  for (const pattern of ['(a|aa)+$', '((a+))+$', '(a{1,3})+$', '(?:a?)+$', 'a+a+a+$', '(?=a)a+', '(a{1,})?', 'a{999999999}', '(a)(b)\\2']) {
    assert.throws(() => compileSafeRegex(pattern), pattern);
  }
  for (const pattern of ['סופר(?:מרקט)?', '^חשבון\\s+בנק$', '^CARD [0-9]{4}$', '(visa|mastercard)', '\\p{L}+']) assert.doesNotThrow(() => compileSafeRegex(pattern));
});

test('encoded known credentials and Telegram URLs are redacted', () => {
  const secret = 'fake "secret" & spaces';
  for (const form of [secret, JSON.stringify(secret), encodeURIComponent(secret), new URLSearchParams({ p: secret }).toString()]) {
    const result = redactSecrets(form, [secret]);
    assert.match(result, /REDACTED/);
    assert.equal(result.includes('secret'), false);
  }
  const token = '123456789:' + 'x'.repeat(35);
  assert.equal(redactSecrets('https://api.telegram.org/bot' + token + '/sendMessage').includes(token), false);
});

test('publication guard scans the index, handles spaces and does not echo secrets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-publish-test-'));
  const guard = path.resolve('scripts/publish-guard.mjs');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const check = (mode = '--staged') => spawnSync(process.execPath, [guard, mode], { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    const token = '123456789:' + 'x'.repeat(35);
    writeFileSync(path.join(dir, 'file with spaces.txt'), token);
    git('add', '.');
    writeFileSync(path.join(dir, 'file with spaces.txt'), 'clean working copy');
    const result = check();
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes(token), false);
    git('add', '.');
    assert.equal(check().status, 0);
    writeFileSync(path.join(dir, 'ledger.db-journal'), 'synthetic');
    git('add', '.');
    assert.equal(check().status, 1);
    git('rm', '--cached', 'ledger.db-journal');
    writeFileSync(path.join(dir, 'file with spaces.txt'), token); git('add', 'file with spaces.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test fixture');
    writeFileSync(path.join(dir, 'file with spaces.txt'), 'clean'); git('add', 'file with spaces.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'remove fixture');
    assert.equal(check('--history').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
