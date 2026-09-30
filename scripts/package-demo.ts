/**
 * Build a self-contained demo folder for someone with nothing installed.
 *   npm run package:demo
 *
 * The person receiving this has no Node, no npm, no toolchain, and no interest
 * in acquiring any. So the output is a folder they unzip and double-click: the
 * Node runtime travels with it, the database ships pre-seeded, and nothing is
 * downloaded or compiled on their machine.
 *
 * WHAT IS DELIBERATELY ABSENT
 * No credentials, no scraper run, no Chromium. Demo mode is a hard flag the
 * server reads, not merely "we left the config empty" - a stranger's first
 * contact with a finance tool should not be able to reach a bank login at all.
 * That also removes the heaviest thing in the tree: Chromium lives in the user
 * profile cache, ~680 MB, and never belongs in a demo.
 *
 * PORT
 * 3020, not 3010. Whoever builds this package almost certainly has the real
 * MyLedger running on 3010, and a demo that dies with "port in use" on the
 * author's own machine never gets tested before it is sent.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The demo packager targets Windows.');

const DEMO_PORT = 3020;
const source = process.cwd();
const out = path.join(source, 'dist-demo');
const pkg = path.join(out, 'MyLedger-Demo');
const app = path.join(pkg, 'app');
const data = path.join(pkg, 'data');
const runtime = path.join(pkg, 'runtime');

for (const required of ['dist', path.join('web', 'dist')]) {
  if (!existsSync(path.join(source, required))) {
    throw new Error(`Missing ${required}. Run "npm run package:demo", which builds first.`);
  }
}

console.log('cleaning…');
rmSync(out, { recursive: true, force: true });
for (const dir of [app, data, runtime]) mkdirSync(dir, { recursive: true });

// ---- the Node runtime travels with the package ----
console.log('copying the Node runtime…');
cpSync(process.execPath, path.join(runtime, 'node.exe'));

// ---- application code ----
console.log('copying application code…');
cpSync(path.join(source, 'dist'), path.join(app, 'dist'), { recursive: true });
cpSync(path.join(source, 'web', 'dist'), path.join(app, 'web', 'dist'), { recursive: true });
mkdirSync(path.join(app, 'prisma'), { recursive: true });
cpSync(path.join(source, 'prisma', 'schema.prisma'), path.join(app, 'prisma', 'schema.prisma'));
cpSync(path.join(source, 'package.json'), path.join(app, 'package.json'));

/**
 * Build-time weight that cannot execute at runtime.
 *  - @prisma/engines, prisma: the CLI and its schema engine. Queries run through
 *    .prisma/client/query_engine-windows.dll.node, which is kept.
 *  - typescript/tsx/@types: the server ships compiled.
 *  - non-SQLite wasm engines: the datasource is SQLite; Prisma can never load
 *    the Postgres/MySQL/CockroachDB/SQL Server variants. ~23 MB of the total.
 */
const DROP_DIRS = new Set(['@prisma/engines', 'prisma', 'typescript', 'tsx', '@types', '.bin']);
const DROP_FILE = /query_engine_bg\.(cockroachdb|postgresql|mysql|sqlserver)\.wasm-base64\.(js|mjs)$/;

console.log('copying dependencies (pruned)…');
let droppedBytes = 0;
function sizeOf(p: string): number {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const e of readdirSync(p)) total += sizeOf(path.join(p, e));
  return total;
}

cpSync(path.join(source, 'node_modules'), path.join(app, 'node_modules'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(path.join(source, 'node_modules'), src).replace(/\\/g, '/');
    if (!rel) return true;
    if (DROP_DIRS.has(rel) || DROP_FILE.test(rel)) {
      try {
        droppedBytes += sizeOf(src);
      } catch {
        /* size reporting only */
      }
      return false;
    }
    return true;
  },
});
console.log(`  pruned ${(droppedBytes / 1024 / 1024).toFixed(0)} MB of build-time weight`);

// ---- a database that already has something to look at ----
console.log('building the demo database…');
const demoDb = path.join(data, 'myledger.db');
const url = `file:${demoDb.replace(/\\/g, '/')}`;
const env = { ...process.env, DATABASE_URL: url };
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env, stdio: 'pipe', shell: true });
execFileSync('npx', ['tsx', 'prisma/seed.ts'], { env, stdio: 'pipe', shell: true });

// The demo must never be able to reach a bank, so this is written next to the
// data rather than left to the launcher, where a stray double-click of the
// wrong file could start it without the flag.
writeFileSync(
  path.join(data, '.env'),
  ['MYLEDGER_DEMO=1', `DATABASE_URL="file:./myledger.db"`, `API_PORT=${DEMO_PORT}`, ''].join('\r\n'),
  'utf8',
);

// ---- launchers ----
// A .cmd so a curious user can see what runs, and a .vbs so the normal path is
// a double-click with no console window left behind.
writeFileSync(
  path.join(pkg, 'start.cmd'),
  [
    '@echo off',
    'cd /d "%~dp0"',
    'set "MYLEDGER_APP_DIR=%~dp0app"',
    'set "MYLEDGER_DATA_DIR=%~dp0data"',
    'set "MYLEDGER_DEMO=1"',
    `set "DATABASE_URL=file:%~dp0data/myledger.db"`,
    `set "API_PORT=${DEMO_PORT}"`,
    `start "" http://127.0.0.1:${DEMO_PORT}`,
    '"%~dp0runtime\\node.exe" "%~dp0app\\dist\\server\\index.js"',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n'),
  'utf8',
);

writeFileSync(
  path.join(pkg, 'MyLedger.vbs'),
  [
    "' Double-click this. Starts MyLedger and opens it in your browser.",
    'Set sh = CreateObject("WScript.Shell")',
    'base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\\"))',
    'sh.CurrentDirectory = base',
    'sh.Run """" & base & "start.cmd""", 0, False',
    '',
  ].join('\r\n'),
  'utf8',
);

writeFileSync(
  path.join(pkg, 'קרא-אותי.txt'),
  [
    'MyLedger — גרסת הדגמה',
    '========================',
    '',
    'הפעלה: לחיצה כפולה על MyLedger.vbs',
    'הדפדפן ייפתח מעצמו על http://127.0.0.1:' + DEMO_PORT,
    '',
    'אין צורך להתקין שום דבר. אין צורך בחיבור לאינטרנט.',
    '',
    'מה זה:',
    '  גרסת הדגמה עם נתונים מומצאים בלבד. אין כאן שום חשבון אמיתי,',
    '  והיא לא יכולה להתחבר לבנק או לחברת אשראי — האפשרות הזאת מנוטרלת.',
    '',
    'לעצור: לסגור את חלון הדפדפן ואת חלון MyLedger בשורת המשימות,',
    '       או פשוט לכבות את המחשב.',
    '',
    'הכל רץ מקומית על המחשב הזה. שום מידע לא נשלח לשום מקום.',
    '',
  ].join('\r\n'),
  'utf8',
);

const total = sizeOf(pkg);
console.log(`\n✓ ${pkg}`);
console.log(`  ${(total / 1024 / 1024).toFixed(0)} MB unpacked · demo port ${DEMO_PORT}`);
console.log('  send the folder as a zip; the recipient double-clicks MyLedger.vbs');
