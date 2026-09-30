/**
 * Security posture check.  npm run secure:check
 *
 * Verifies the properties that keep the threat model down to "someone runs code
 * as me". Everything here is checked, not assumed - exit code 1 if a check fails.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_PATH } from '../src/config.js';
import { isProtected } from '../src/secrets.js';
import { assessDependencyAudit } from '../src/dependency-audit.js';

const run = promisify(execFile);

interface Check {
  name: string;
  pass: boolean | null; // null = could not determine
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, pass: boolean | null, detail: string) => checks.push({ name, pass, detail });

async function main() {
  // --- credentials at rest ---
  if (existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as {
      accounts?: Array<{ credentials: Record<string, string> }>;
    };
    const values = (cfg.accounts ?? []).flatMap((a) => Object.values(a.credentials ?? {}));
    const plain = values.filter((v) => !isProtected(v));
    add(
      'Credentials encrypted at rest (DPAPI)',
      values.length > 0 && plain.length === 0,
      plain.length === 0 ? `${values.length}/${values.length} encrypted` : `${plain.length} still plaintext — run "npm run secure"`,
    );
  } else {
    add('Credentials encrypted at rest (DPAPI)', null, 'no accounts.config.json');
  }

  // --- browser profile cookies ---
  const profilesRoot = path.resolve('.browser-profiles');
  if (existsSync(profilesRoot)) {
    let sealed = 0;
    let total = 0;
    let busy = 0;
    for (const dir of readdirSync(profilesRoot)) {
      const localState = path.join(profilesRoot, dir, 'Local State');
      if (!existsSync(localState)) continue;
      total++;
      try {
        const key = JSON.parse(readFileSync(localState, 'utf-8'))?.os_crypt?.encrypted_key;
        if (key && Buffer.from(key, 'base64').subarray(0, 5).toString('ascii') === 'DPAPI') sealed++;
      } catch {
        // Chromium holds this file open while a scrape is in flight.
        busy++;
      }
    }
    add(
      'Browser session cookies sealed by DPAPI',
      total === 0 ? null : busy > 0 && sealed + busy === total ? null : sealed === total,
      total === 0
        ? 'no profiles yet'
        : busy > 0
          ? `${sealed}/${total} verified, ${busy} in use right now — re-check when no scrape is running`
          : `${sealed}/${total} profile master keys DPAPI-wrapped`,
    );
  } else {
    add('Browser session cookies sealed by DPAPI', null, 'no .browser-profiles yet');
  }

  // --- disk encryption ---
  try {
    const { stdout } = await run('manage-bde', ['-status', 'C:', '-protectionaserrorlevel']);
    void stdout;
    add('BitLocker protection on C:', true, 'protection on');
  } catch {
    // -protectionaserrorlevel exits non-zero when protection is off, but also
    // when the command needs elevation - so report honestly rather than guess.
    add('BitLocker protection on C:', null, 'needs an elevated shell: manage-bde -status C:');
  }

  // --- API not exposed ---
  const serverSrc = readFileSync(path.resolve('src/server/index.ts'), 'utf-8');
  const loopback = /const HOST = '127\.0\.0\.1'/.test(serverSrc);
  add('Dashboard API bound to loopback only', loopback, loopback ? "HOST = '127.0.0.1'" : 'HOST is not loopback!');

  // --- protected production runtime ---
  const runtimeRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'MyLedger') : '';
  if (runtimeRoot && existsSync(runtimeRoot)) {
    try {
      const { stdout } = await run('icacls', [runtimeRoot]);
      const exposed = /CodexSandboxUsers|BUILTIN\\Users|Everyone|Authenticated Users|INTERACTIVE/i.test(stdout);
      add(
        'Production runtime ACL excludes development tools',
        !exposed,
        exposed ? 'a broad principal can modify the runtime' : 'only you, SYSTEM and Administrators',
      );
    } catch {
      add('Production runtime ACL excludes development tools', null, 'could not read runtime ACL');
    }
    try {
      const { stdout: syncXml } = await run('schtasks', ['/Query', '/TN', 'MyLedger daily sync', '/XML']);
      const { stdout: apiXml } = await run('schtasks', ['/Query', '/TN', 'MyLedger dashboard', '/XML']);
      const protectedPath = path.join(process.env.LOCALAPPDATA!, 'MyLedger').toLowerCase();
      const pointsProtected = syncXml.toLowerCase().includes(protectedPath) && apiXml.toLowerCase().includes(protectedPath);
      add('Scheduled tasks execute protected runtime', pointsProtected, pointsProtected ? protectedPath : 'one or more tasks still point at the repo');
    } catch {
      add('Scheduled tasks execute protected runtime', false, 'scheduled tasks missing or unreadable');
    }
  } else {
    add('Production runtime ACL excludes development tools', false, 'run "npm run deploy:local"');
    add('Scheduled tasks execute protected runtime', false, 'protected runtime is not deployed');
  }

  // --- git exposure ---
  if (existsSync('.git')) {
    try {
      const { stdout } = await run('git', ['ls-files']);
      const tracked = stdout
        .split('\n')
        .filter((f) => /^(accounts\.config\.json|\.env$|\.browser-profiles\/|prisma\/.*\.db$)/.test(f.trim()));
      add('No secrets tracked by git', tracked.length === 0, tracked.length ? `TRACKED: ${tracked.join(', ')}` : 'clean');
    } catch {
      add('No secrets tracked by git', null, 'git not available');
    }
    let hookInstalled = existsSync(path.join('.git', 'hooks', 'pre-commit'));
    try {
      const { stdout } = await run('git', ['config', '--get', 'core.hooksPath']);
      const hooksPath = stdout.trim();
      hookInstalled ||= !!hooksPath && existsSync(path.join(hooksPath, 'pre-commit'));
    } catch {
      /* no custom hooks path */
    }
    add('Pre-commit secret guard installed', hookInstalled, hookInstalled ? 'installed' : 'run "npm run secure"');
  } else {
    add('No secrets tracked by git', null, 'no repository yet (nothing can leak)');
  }

  // --- dependency vulnerabilities ---
  // No exceptions, including development and frontend dependencies.
  for (const project of ['server', 'web']) try {
    const { stdout } = await run('npm', ['audit', '--json', ...(project === 'web' ? ['--prefix', 'web'] : [])], { shell: true, maxBuffer: 32 * 1024 * 1024 }).catch(
      (e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }),
    );
    const { unexpected } = assessDependencyAudit(JSON.parse(stdout.replace(/^﻿/, '')));
    add(
      `No known vulnerabilities in ${project} dependencies (including dev)`,
      unexpected.length === 0,
      unexpected.length
        ? `advisories: ${unexpected.join(', ')} — run "npm audit"`
        : 'npm audit clean — no exceptions',
    );
  } catch {
    add(`No known vulnerabilities in ${project} dependencies (including dev)`, null, 'npm audit unavailable or incomplete; NOT a clean result');
  }

  // --- report ---
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log('');
  for (const c of checks) {
    const mark = c.pass === true ? '✓' : c.pass === false ? '✗' : '?';
    console.log(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
  }

  const failed = checks.filter((c) => c.pass === false);
  const unknown = checks.filter((c) => c.pass === null);
  console.log(
    `\n${checks.filter((c) => c.pass === true).length} passed, ${failed.length} failed, ${unknown.length} indeterminate`,
  );
  if (failed.length || unknown.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
