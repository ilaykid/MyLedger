/**
 * Harden the local install.  npm run secure
 *
 * Closes every exposure path that does NOT require running code as you:
 *   1. encrypts credentials with Windows DPAPI (a copied file becomes useless)
 *   2. verifies no broad NTFS grant exposes the files to other local accounts
 *   3. installs a git pre-commit hook that refuses to commit a secret
 *
 * Safe to re-run; already-encrypted values are left alone.
 *
 * On step 2 - why verify instead of tighten: an earlier version of this script
 * stripped inheritance and re-granted only the current user. That turned out to
 * be all cost and no benefit. A project under C:\Users\<you>\ already inherits a
 * DACL limited to SYSTEM, Administrators and you - no Users, Everyone or
 * Authenticated Users - so another standard local account cannot read it either
 * way. Removing SYSTEM/Administrators buys nothing (an admin can retake
 * ownership, and anything running as you can simply ask DPAPI to decrypt), while
 * the `(OI)(CI)` inheritance flags are invalid on files and produce an EMPTY
 * DACL that locks out the owner too. It did exactly that, twice. So: check the
 * property, do not fight the OS for it.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, accessSync, constants } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_PATH } from '../src/config.js';
import { isProtected, protect } from '../src/secrets.js';

const run = promisify(execFile);

/** Files that must never be readable by another local account. */
const SENSITIVE = ['accounts.config.json', '.env', '.browser-profiles', path.join('prisma', 'myledger.db')];

const HOOK = `#!/bin/sh
# Installed by "npm run secure". Refuses to commit files that hold credentials.
blocked=$(git diff --cached --name-only | grep -E '^(accounts\\.config\\.json|\\.env$|\\.browser-profiles/|prisma/.*\\.db$)' || true)
if [ -n "$blocked" ]; then
  echo "COMMIT BLOCKED - these files contain credentials or live session data:"
  echo "$blocked" | sed 's/^/  /'
  echo ""
  echo "They are in .gitignore; you are seeing this because something forced them in."
  echo "If you are certain, bypass with: git commit --no-verify"
  exit 1
fi
`;

async function encryptCredentials(): Promise<{ encrypted: number; already: number }> {
  if (!existsSync(CONFIG_PATH)) {
    console.log('  no accounts.config.json - nothing to encrypt');
    return { encrypted: 0, already: 0 };
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as {
    accounts?: Array<{ company: string; credentials: Record<string, string> }>;
  };

  let encrypted = 0;
  let already = 0;

  for (const account of config.accounts ?? []) {
    for (const [field, value] of Object.entries(account.credentials ?? {})) {
      if (isProtected(value)) {
        already++;
        continue;
      }
      account.credentials[field] = await protect(value);
      encrypted++;
    }
  }

  if (encrypted > 0) {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
  return { encrypted, already };
}

/** Principals whose presence would mean another local account can read the file. */
const BROAD_PRINCIPALS = ['BUILTIN\\Users', 'Everyone', 'Authenticated Users', 'INTERACTIVE'];

async function verifyPermissions(): Promise<boolean> {
  let allGood = true;

  for (const target of SENSITIVE) {
    const full = path.resolve(process.cwd(), target);
    if (!existsSync(full)) continue;

    let acl = '';
    try {
      const { stdout } = await run('icacls', [full]);
      acl = stdout;
    } catch (err) {
      console.log(`  ? ${target}: could not read ACL (${err instanceof Error ? err.message.split('\n')[0] : err})`);
      continue;
    }

    const exposed = BROAD_PRINCIPALS.filter((p) => acl.includes(p));
    // An unreadable file is as broken as an over-shared one - check both.
    let readable = true;
    try {
      accessSync(full, constants.R_OK);
    } catch {
      readable = false;
    }

    if (!readable) {
      allGood = false;
      console.log(`  ✗ ${target}: NOT READABLE by you - run: icacls "${full}" /grant "%USERNAME%:F"`);
    } else if (exposed.length > 0) {
      allGood = false;
      console.log(`  ✗ ${target}: readable by ${exposed.join(', ')} - move the project under C:\\Users\\%USERNAME%\\`);
    } else {
      console.log(`  ✓ ${target}: limited to you, SYSTEM and Administrators`);
    }
  }

  return allGood;
}

function installGitHook(): void {
  const gitDir = path.resolve(process.cwd(), '.git');
  if (!existsSync(gitDir)) {
    console.log('  no git repository yet - re-run "npm run secure" after "git init"');
    return;
  }
  const versionedHook = path.resolve('.githooks', 'pre-commit');
  const hookPath = existsSync(versionedHook) ? versionedHook : path.join(gitDir, 'hooks', 'pre-commit');
  if (!existsSync(versionedHook)) writeFileSync(hookPath, HOOK, 'utf-8');
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* chmod is a no-op on Windows */
  }
  if (existsSync(versionedHook)) {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
    console.log('  using versioned .githooks/pre-commit');
  } else {
    console.log('  installed .git/hooks/pre-commit');
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('This hardening script targets Windows (DPAPI + icacls).');
    process.exitCode = 1;
    return;
  }

  console.log('1. Encrypting credentials with DPAPI');
  const { encrypted, already } = await encryptCredentials();
  console.log(`   ${encrypted} newly encrypted, ${already} already encrypted`);

  console.log('\n2. Verifying file permissions');
  const permissionsOk = await verifyPermissions();

  console.log('\n3. Git safety net');
  installGitHook();

  console.log('\nDone. Remaining exposure requires code execution as your Windows user.');
  console.log('Verify with:  npm run secure:check');
  if (!permissionsOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
