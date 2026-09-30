import test from 'node:test';
import assert from 'node:assert/strict';
import { assignOccurrences, computeDedupHash } from '../src/dedup.js';
import { classify } from '../src/cashflow.js';
import { slicesFor } from '../src/spread.js';
import { merchantPattern, ruleMatches } from '../src/categorize.js';

test('spread slices preserve every agora and clamp end-of-month dates', () => {
  const slices = slicesFor({
    months: 3,
    offsetMonths: 0,
    transaction: { date: new Date(2026, 0, 31), amount: 10_001 },
  });
  assert.deepEqual(slices.map((slice) => slice.date.getDate()), [31, 28, 31]);
  assert.equal(slices.reduce((sum, slice) => sum + slice.amount, 0), 10_001);
});

test('identical transactions get stable distinct occurrence hashes', () => {
  const row = {
    dateISO: '2026-08-04',
    amountAgorot: -2_500,
    normalizedDescription: 'קפה',
    providerIdentifier: null,
  };
  const batch = assignOccurrences('visaCal', '1234', [row, row]);
  assert.notEqual(batch[0].dedupHash, batch[1].dedupHash);
  assert.equal(batch[0].dedupHash, computeDedupHash('visaCal', '1234', row, 0));
});

test('explicit non-cashflow and split income categories win inference', () => {
  const bank = { type: 'bank' };
  assert.equal(classify({ amount: 5_000, account: bank, category: { kind: 'income_fixed' } }), 'income_fixed');
  assert.equal(classify({ amount: -5_000, account: bank, category: { kind: 'excluded' } }), 'excluded');
  assert.equal(classify({ amount: -5_000, account: bank, category: { kind: 'transfer' } }), 'transfer');
});

test('a merchant rule keeps the name, drops the noise, and still matches its source', () => {
  const cases: Array<[string, string]> = [
    ['שופרסל דיל 1234 חיפה', 'שופרסל דיל'],
    ['רמי לוי', 'רמי לוי'],
    ['PAYPAL *STEAM GAMES', 'PAYPAL *STEAM GAMES'],
    ['הוראת קבע 12345678', 'הוראת קבע'],
  ];
  for (const [description, expected] of cases) {
    const pattern = merchantPattern(description);
    assert.equal(pattern, expected);
    // The whole point: a `contains` rule built from it must match the row it
    // came from, which only holds if the pattern is a real slice of it.
    assert.ok(ruleMatches({ id: 'r', pattern, matchType: 'contains', priority: 0, categoryId: 'c' }, description));
  }
});

test('descriptions with no readable name produce no rule', () => {
  assert.equal(merchantPattern('1111-2222-3333'), '');
  assert.equal(merchantPattern('12 34'), '');
});
