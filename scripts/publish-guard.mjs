/** Scan the bytes Git will publish. Never print a matched secret. No dependencies. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const mode = process.argv[2] ?? '--worktree';
if (!['--staged', '--history', '--worktree'].includes(mode)) throw new Error('Unknown publish scan mode');
const errors = new Set();
const seen = new Set();
const forbidden = /(^|\/)(?:accounts\.config\.json(?:\..*)?|backup\.config\.json(?:\..*)?|\.env(?:\..*)?|[^/]*\.(?:db(?:-wal|-shm|-journal)?|sqlite3?|mlbk|log(?:\.\d+)?|pem|key)|\.browser-profiles|\.claude|\.codex|private|screenshots|dist-demo)(?:\/|$)/i;
function scan(file, bytes) {
  if (forbidden.test(file) && !/(^|\/)\.env\.example$/.test(file)) errors.add(`${file}: sensitive runtime path`);
  if (/\.(png|jpe?g|gif|ico|woff2?)$/i.test(file)) return; // Images require visual review.
  const body = bytes.toString('utf8');
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    /\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /dpapi:[A-Za-z0-9+/=]{40,}/,
  ];
  if (patterns.some(pattern => pattern.test(body))) errors.add(`${file}: credential pattern (value withheld)`);
}
try {
  if (mode === '--staged') {
    // Inspect the index, even if the working copy was subsequently cleaned up.
    const names = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').toString('utf8').split('\0').filter(Boolean);
    for (const file of names) scan(file, git('show', `:${file}`));
  } else if (mode === '--history') {
    // A blob can appear under both a harmless and a sensitive name; rev-list
    // reports only one name per object, so check every historical tree too.
    for (const commit of git('rev-list', '--all').toString('utf8').trim().split('\n').filter(Boolean)) {
      for (const file of git('ls-tree', '-r', '--name-only', '-z', commit).toString('utf8').split('\0').filter(Boolean)) {
        if (forbidden.test(file) && !/(^|\/)\.env\.example$/.test(file)) errors.add(`${file}: sensitive runtime path in history`);
      }
    }
    for (const line of git('rev-list', '--objects', '--all').toString('utf8').split('\n').filter(Boolean)) {
      const space = line.indexOf(' '), id = space < 0 ? line : line.slice(0, space), file = space < 0 ? '' : line.slice(space + 1);
      if (seen.has(id)) continue;
      seen.add(id);
      const type = git('cat-file', '-t', id).toString('utf8').trim();
      if (type === 'blob') scan(file, git('cat-file', 'blob', id));
      // Commit/tag messages and identities are public as well.
      if (type === 'commit' || type === 'tag') scan(`${type} ${id.slice(0, 12)}`, git('cat-file', type, id));
    }
  } else {
    const names = git('ls-files', '-co', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean);
    for (const file of new Set(names)) {
      try { scan(file, readFileSync(file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
} catch {
  errors.add('Could not complete publication scan; refusing to report clean');
}
for (const error of errors) console.error(error);
if (errors.size) process.exitCode = 1;
else console.log(`Publication credential/path scan passed (${mode}). Images and personal prose still need review.`);
