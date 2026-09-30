import { prisma } from './db.js';
import { sendDigest } from './notify.js';
import { buildDigest, digestForToday, type DigestKind } from './digests.js';

/**
 *   npm run notify                    send the digest today calls for
 *   npm run notify -- weekly          force a specific one
 *   npm run notify:preview            print it instead of sending
 *   npm run notify:preview -- monthly
 *
 * `preview` is a positional word rather than `--preview` on purpose: npm's own
 * argument parser swallows unrecognised `--flags` even after `--`, so the script
 * never sees them. (The same trap turned `--only` into `--company` earlier.)
 */
async function main() {
  const args = process.argv.slice(2);
  const preview = args.includes('preview') || args.includes('--preview');
  const explicit = args.find((a) => ['daily', 'weekly', 'monthly'].includes(a)) as DigestKind | undefined;
  const kind = explicit ?? digestForToday();

  if (preview) {
    const text = await buildDigest(kind);
    console.log(`--- ${kind} digest (not sent) ---\n`);
    // Telegram renders these; the terminal should not show the markup.
    console.log(text.replace(/<\/?(b|i|code)>/g, ''));
    return;
  }

  const result = await sendDigest(kind);
  if (result.sent) {
    console.log(`Sent the ${result.kind} digest.`);
  } else if (result.error === 'not_configured') {
    console.log('Telegram is not configured - set it up on the Connections page.');
  } else {
    console.error(`Failed to send: ${result.error}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
