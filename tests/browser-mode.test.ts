import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readShowBrowser } from '../src/browser-mode.js';

test('browser setting reloads from the active file over stale startup environment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-mode-'));
  const file = path.join(dir, '.env');
  try {
    assert.equal(readShowBrowser(file, 'false'), false);
    writeFileSync(file, 'SCRAPER_SHOW_BROWSER=true');
    assert.equal(readShowBrowser(file, 'false'), true);
    writeFileSync(file, 'SCRAPER_SHOW_BROWSER=" FALSE "');
    assert.equal(readShowBrowser(file, 'true'), false);
    writeFileSync(file, 'SCRAPER_SHOW_BROWSER=typo');
    assert.throws(() => readShowBrowser(file), /must be true or false/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
