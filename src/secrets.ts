import { spawn } from 'node:child_process';

/**
 * Credential encryption at rest, using Windows DPAPI (CurrentUser scope).
 *
 * Why DPAPI: the key is derived from your Windows account and sealed by the OS.
 * A copied accounts.config.json is worthless on another machine, under another
 * Windows user, or to anyone reading the file without running code AS you - which
 * is exactly the bar the browser profile already meets (Chromium seals its cookie
 * master key the same way). It also keeps unattended scraping working: no
 * passphrase to type at 05:30.
 *
 * Why no npm package: `win-dpapi` and friends are native modules, and adding a
 * dependency to *improve* security while enlarging the supply-chain surface is
 * self-defeating. PowerShell exposes the same OS API with nothing to install.
 *
 * The plaintext travels over stdin, never on a command line - process command
 * lines are readable by other processes on the machine.
 */

const PREFIX = 'dpapi:';

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'\n" + script], {
      windowsHide: true,
      timeout: 30_000,
    });
    let stdout = '';
    ps.stdout.on('data', (d) => (stdout += d.toString()));
    ps.stderr.resume(); // Do not surface PowerShell diagnostics containing input.
    ps.stdin.on('error', reject);
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) resolve(stdout); // Whitespace can be part of a password.
      else reject(new Error(`DPAPI call failed (exit ${code})`));
    });
    ps.stdin.write(input);
    ps.stdin.end();
  });
}

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($in)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($enc))
`.trim();

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($in)
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($dec))
`.trim();

export function isProtected(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function protect(plaintext: string): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Credential encryption currently supports Windows (DPAPI) only.');
  }
  const blob = await runPowerShell(PROTECT_SCRIPT, plaintext);
  if (!blob) throw new Error('DPAPI returned an empty blob');
  return PREFIX + blob;
}

export async function unprotect(value: string): Promise<string> {
  if (!isProtected(value)) return value; // plaintext, left as-is
  const blob = value.slice(PREFIX.length);
  try {
    return await runPowerShell(UNPROTECT_SCRIPT, blob);
  } catch (err) {
    throw new Error(
      'Could not decrypt a stored credential. DPAPI keys are bound to the Windows user ' +
        'account that encrypted them - this fails if the file was copied from another machine ' +
        'or user, or after a Windows account reset. Re-enter the credentials and run ' +
        '"npm run secure" again.\n' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Decrypt every value in a credentials object, leaving plaintext values alone. */
export async function unprotectAll(credentials: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    out[key] = await unprotect(value);
  }
  return out;
}
