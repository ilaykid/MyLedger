import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfigFromFile } from '@prisma/config';

const require = createRequire(import.meta.url);

test('Prisma config override merges circular objects without overflowing the stack', () => {
  const prismaRequire = createRequire(require.resolve('@prisma/config'));
  const { deepmerge } = prismaRequire('deepmerge-ts');
  const a: Record<string, unknown> = { first: 1 }; a.self = a;
  const b: Record<string, unknown> = { second: 2 }; b.self = b;
  const result = deepmerge(a, b);
  assert.equal(result.first, 1);
  assert.equal(result.second, 2);
  assert.equal(result.self, result);
});

test('Prisma loads a local configuration with the overridden merger', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ledger-prisma-config-'));
  try {
    writeFileSync(path.join(root, 'prisma.config.ts'), 'export default { schema: "./schema.prisma", migrations: { path: "./migrations" } };');
    const result = await loadConfigFromFile({ configRoot: root });
    assert.equal(result.error, undefined);
    assert.equal(result.config?.schema, path.join(root, 'schema.prisma'));
    assert.equal(result.config?.migrations?.path, path.join(root, 'migrations'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Opt in because CI hosts may deliberately skip downloading Chrome.
// Run MYLEDGER_TEST_BROWSER=1 npm test after installing Puppeteer's browser.
test('Puppeteer override supports the scraper lifecycle and persistent cookies', {
  skip: process.env.MYLEDGER_TEST_BROWSER !== '1', timeout: 90_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ledger-browser-compat-'));
  const previousRoot = process.env.MYLEDGER_DATA_DIR;
  process.env.MYLEDGER_DATA_DIR = root;
  const { launchPersistentBrowser, closeBrowserCleanly, clearGateCookies } = await import('../src/browser.js');
  let browser;
  try {
    const scraperRequire = createRequire(require.resolve('israeli-bank-scrapers'));
    assert.equal(scraperRequire.resolve('puppeteer'), require.resolve('puppeteer'));
    // Exercise the upstream CommonJS require(ESM) boundary, not a mock.
    const { BaseScraperWithBrowser } = require('israeli-bank-scrapers/lib/scrapers/base-scraper-with-browser.js');
    browser = await launchPersistentBrowser('compat-fixture', { headless: true });
    const scraper = new BaseScraperWithBrowser({ companyId: 'fixture', browser, skipCloseBrowser: true });
    await scraper.initialize();
    await scraper.page.setContent('<input id="fixture"><p>synthetic</p>');
    await scraper.fillInputs(scraper.page, [{ selector: '#fixture', value: 'fixture text' }]);
    assert.equal(await scraper.page.$eval('#fixture', (el: HTMLInputElement) => el.value), 'fixture text');
    await browser.setCookie(
      { name: 'device-fixture', value: 'synthetic', domain: 'example.invalid', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 },
      { name: '__cfwaitingroom', value: 'synthetic', domain: 'example.invalid', path: '/' },
    );
    assert.equal(await clearGateCookies(browser), 1);
    await scraper.terminate(true);
    assert.equal(scraper.page.isClosed(), true);
    assert.equal(browser.connected, true);
    await closeBrowserCleanly(browser);
    browser = await launchPersistentBrowser('compat-fixture', { headless: true });
    assert.equal((await browser.cookies()).some(c => c.name === 'device-fixture'), true);
    assert.equal((await browser.pages()).length, 1);
  } finally {
    if (browser) await closeBrowserCleanly(browser);
    if (previousRoot === undefined) delete process.env.MYLEDGER_DATA_DIR;
    else process.env.MYLEDGER_DATA_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
