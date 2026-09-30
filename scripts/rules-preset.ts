/**
 * Re-apply the Israeli merchant preset.  npm run rules:preset
 *
 * Idempotent: adds any missing category or rule, then re-applies the rules and
 * re-runs recurring detection. See src/preset.ts for the taxonomy itself.
 */
import { prisma } from '../src/db.js';
import { applyPreset } from '../src/preset.js';

applyPreset((line) => console.log(line))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
