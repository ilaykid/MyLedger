/**
 * Export a publishable copy with a fresh, single-commit history.
 *
 *   npm run export:public -- <target-dir> ["Name <email>"]
 *
 * A personal working copy's history is a record of real life: commit messages
 * quote real balances, and old diffs still hold comments that were cleaned up
 * later. Rewriting that history is error-prone; not publishing it is not. This
 * copies the files of the current commit - nothing else - into a new repository.
 *
 * Refuses unless the working tree is clean (so what was checked is exactly what
 * is exported) and the privacy check passes. The target must not exist yet.
 *
 * The author is optional. Without it the files are staged but not committed,
 * so you choose the identity: GitHub shows the commit email publicly, and its
 * "noreply" address (Settings -> Emails) keeps your real one private.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [targetArg, author] = process.argv.slice(2);
if (!targetArg) {
  console.error('Usage: npm run export:public -- <target-dir> ["Name <email>"]');
  process.exit(1);
}
const target = path.resolve(targetArg);
const git = (args: string[], cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8' });

if (existsSync(target)) {
  console.error(`Refusing: ${target} already exists. Pick a new folder.`);
  process.exit(1);
}
if (git(['status', '--porcelain']).trim()) {
  console.error('Refusing: the working tree has uncommitted changes. Commit first, so the export matches what was checked.');
  process.exit(1);
}

console.log('Running the privacy check...');
try {
  execFileSync('npm', ['run', '--silent', 'git:safe-check'], { stdio: 'inherit', shell: true });
} catch {
  console.error('\nRefusing: fix the privacy check first.');
  process.exit(1);
}

const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
mkdirSync(target, { recursive: true });
for (const file of files) {
  const destination = path.join(target, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  // Committed content, byte for byte - binary safe.
  writeFileSync(destination, execFileSync('git', ['show', `HEAD:${file}`], { maxBuffer: 64 * 1024 * 1024 }));
}

git(['init', '-q', '-b', 'main'], target);
git(['config', 'core.hooksPath', '.githooks'], target);
git(['add', '-A'], target);
console.log(`\n✓ Exported ${files.length} files to ${target} (fresh history, nothing pushed)`);

if (author) {
  const match = /^(.+?)\s*<([^>]+)>$/.exec(author);
  if (!match) {
    console.error('Author must look like "Name <email>". Files are staged; commit by hand.');
    process.exit(1);
  }
  execFileSync(
    'git',
    ['-c', `user.name=${match[1]}`, '-c', `user.email=${match[2]}`, 'commit', '-q', '-m', 'Initial public release'],
    { cwd: target },
  );
  console.log(`✓ Committed as ${match[1]} <${match[2]}>`);
} else {
  console.log('  Files are staged, not committed. Choose the public identity, e.g.:');
  console.log('    git -c user.email=<id>+<user>@users.noreply.github.com commit -m "Initial public release"');
}
console.log('\nNext: create an EMPTY repository on GitHub, then in the new folder:');
console.log('    git remote add origin https://github.com/<user>/<repo>.git');
console.log('    git push -u origin main');
