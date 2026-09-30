/**
 * Interactive account manager.
 *
 *   npm run accounts              list configured accounts
 *   npm run accounts -- add       add one, prompting for each field
 *   npm run accounts -- update    replace the credentials of an existing one
 *   npm run accounts -- remove    delete one
 *
 * Passwords are typed masked and encrypted with DPAPI *before* anything is
 * written, so plaintext never reaches the disk - not in the config, not in an
 * editor's undo history, not in a swap file. That is the whole point of doing
 * this interactively instead of editing JSON by hand.
 */
import { type Interface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SCRAPERS } from 'israeli-bank-scrapers';
import { CONFIG_PATH } from '../src/config.js';
import { isProtected, protect } from '../src/secrets.js';
import { ask, askHidden, requireTTY, withPrompt } from '../src/prompt.js';

interface Account {
  company: string;
  displayName?: string;
  credentials: Record<string, string>;
}

interface ConfigFile {
  accounts: Account[];
  [key: string]: unknown;
}

const PROVIDERS = SCRAPERS as Record<string, { name: string; loginFields: string[] }>;
/** Fields whose input must not be echoed. */
const SECRET_FIELDS = new Set(['password', 'otpLongTermToken']);

function readConfig(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) return { accounts: [] };
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ConfigFile;
  parsed.accounts ??= [];
  return parsed;
}

function writeConfig(config: ConfigFile): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function listAccounts(config: ConfigFile): void {
  if (config.accounts.length === 0) {
    console.log('No accounts configured yet. Add one with:  npm run accounts -- add');
    return;
  }
  console.log(`${config.accounts.length} account(s):\n`);
  for (const [i, a] of config.accounts.entries()) {
    const fields = Object.entries(a.credentials ?? {})
      .map(([k, v]) => `${k}=${isProtected(v) ? '🔒encrypted' : '⚠️PLAINTEXT'}`)
      .join(', ');
    console.log(`  ${i + 1}. ${a.company}${a.displayName ? ` — ${a.displayName}` : ''}`);
    console.log(`     ${fields}`);
  }
  const anyPlain = config.accounts.some((a) => Object.values(a.credentials ?? {}).some((v) => !isProtected(v)));
  if (anyPlain) console.log('\n⚠️  Some credentials are still plaintext. Run:  npm run secure');
}

async function pickAccount(rl: Interface, config: ConfigFile, verb: string): Promise<number | null> {
  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    return null;
  }
  listAccounts(config);
  const answer = await ask(rl, `\nWhich account to ${verb}? (number, or blank to cancel): `);
  if (!answer) return null;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= config.accounts.length) {
    console.log('Not a valid number.');
    return null;
  }
  return index;
}

/** Prompt for every field the provider needs, encrypting secrets immediately. */
async function promptCredentials(rl: Interface, company: string): Promise<Record<string, string>> {
  const fields = PROVIDERS[company].loginFields;
  const credentials: Record<string, string> = {};

  console.log(`\n${company} needs: ${fields.join(', ')}`);
  console.log('(passwords are masked and encrypted before anything is saved)\n');

  for (const field of fields) {
    const secret = SECRET_FIELDS.has(field);
    let value = '';
    while (!value) {
      value = secret ? await askHidden(rl, `  ${field}: `) : await ask(rl, `  ${field}: `);
      if (!value) console.log('    (required)');
    }
    credentials[field] = await protect(value);
  }
  return credentials;
}

async function addAccount(rl: Interface, config: ConfigFile): Promise<void> {
  console.log('Available providers:\n');
  const ids = Object.keys(PROVIDERS);
  for (let i = 0; i < ids.length; i += 3) {
    console.log('  ' + ids.slice(i, i + 3).map((id) => id.padEnd(20)).join(''));
  }

  const company = await ask(rl, '\nProvider id: ');
  if (!company) return;
  if (!(company in PROVIDERS)) {
    console.log(`Unknown provider "${company}".`);
    return;
  }
  if (config.accounts.some((a) => a.company === company)) {
    console.log(`${company} is already configured. Use "npm run accounts -- update" to change it.`);
    return;
  }

  const displayName = await ask(rl, `Display name (blank for "${PROVIDERS[company].name}"): `);
  const credentials = await promptCredentials(rl, company);

  config.accounts.push({
    company,
    displayName: displayName || PROVIDERS[company].name,
    credentials,
  });
  writeConfig(config);

  console.log(`\n✓ Added ${company}, credentials encrypted with DPAPI.`);
  console.log('\nNext:');
  console.log(`  npm run login -- ${company}          # one-time interactive login`);
  console.log(`  npm run scrape -- --company ${company}`);
}

async function updateAccount(rl: Interface, config: ConfigFile): Promise<void> {
  const index = await pickAccount(rl, config, 'update');
  if (index === null) return;
  const account = config.accounts[index];
  account.credentials = await promptCredentials(rl, account.company);
  writeConfig(config);
  console.log(`\n✓ Updated ${account.company}, credentials re-encrypted.`);
}

async function removeAccount(rl: Interface, config: ConfigFile): Promise<void> {
  const index = await pickAccount(rl, config, 'remove');
  if (index === null) return;
  const account = config.accounts[index];
  const confirm = await ask(rl, `Remove ${account.company}? Type "yes" to confirm: `);
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Cancelled.');
    return;
  }
  config.accounts.splice(index, 1);
  writeConfig(config);
  console.log(`\n✓ Removed ${account.company}.`);
  console.log(`  Its browser profile is still on disk: .browser-profiles/${account.company}`);
  console.log('  Delete it too if you are done with this provider (it holds session cookies).');
}

async function main() {
  const command = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'list';
  const config = readConfig();

  if (command === 'list') {
    listAccounts(config);
    return;
  }

  if (!requireTTY()) {
    process.exitCode = 1;
    return;
  }

  await withPrompt(async (rl) => {
    if (command === 'add') await addAccount(rl, config);
    else if (command === 'update') await updateAccount(rl, config);
    else if (command === 'remove') await removeAccount(rl, config);
    else {
      console.log(`Unknown command "${command}". Use: list | add | update | remove`);
      process.exitCode = 1;
    }
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
