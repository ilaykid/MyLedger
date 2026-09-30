import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
for (const name of ['api.log', 'nightly.log']) {
  const file = path.resolve(name);
  if (!existsSync(file) || statSync(file).size < MAX_BYTES) continue;
  const previous = `${file}.1`;
  if (existsSync(previous)) unlinkSync(previous);
  renameSync(file, previous);
}
