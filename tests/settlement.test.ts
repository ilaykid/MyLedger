import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSettlements, type SettlementRow } from '../src/settlement-reconciliation.js';
const since = new Date(2026, 5, 17), today = new Date(2026, 8, 17), charge = new Date(2026, 6, 10);
function row(id: string, bank = false, amount = -10000): SettlementRow {
    return { id, accountId: bank ? 'bank' : 'card', amount, currency: 'ILS', status: 'completed', date: charge,
        processedDate: bank ? null : charge, description: bank ? '1234 - ישראכרט בע״מ' : 'קנייה',
        account: { type: bank ? 'bank' : 'credit_card', institution: bank ? 'leumi' : 'isracard', displayName: id, lastFour: '1234', lifecycle: 'active' } };
}
test('statement reconciliation includes old purchases and subtracts refunds exactly', () => {
    const old = { ...row('old', false, -15000), date: new Date(2026, 4, 1) };
    const refund = row('refund', false, 5000), bank = row('bank', true);
    const result = reconcileSettlements([old, refund, bank], since, today);
    assert.equal(result.settlements[0].status, 'matched');
    assert.equal(result.settlements[0].cardAmount, -10000);
    assert.equal(result.settlements[0].difference, 0);
    assert.equal(result.settlements[0].count, 2);
});
test('equal amount alone cannot match another issuer, currency, card or merchant', () => {
    for (const wrong of [{ description: 'מקס איט פיננסים' }, { description: 'סופרמרקט' }, { currency: 'USD' }, { description: '9999 - ישראכרט' }]) {
        const result = reconcileSettlements([row('card'), { ...row('bank', true), ...wrong }], since, today);
        assert.equal(result.settlements[0].status, 'review');
        assert.equal(result.matchedBank.size, 0);
    }
});
test('shekel symbol and ISO aliases are one statement, without converting foreign currencies', () => {
    const result = reconcileSettlements([{...row('symbol', false, -5000), currency:'₪'}, {...row('iso', false, -5000), currency:'NIS'}, row('bank', true)], since, today);
    assert.equal(result.settlements.length, 1);
    assert.equal(result.settlements[0].status, 'matched');
    assert.equal(result.settlements[0].currency, 'ILS');
    assert.equal(result.settlements[0].count, 2);
});
test('posting shifts are supported but a one-agora difference stays visible', () => {
    const shifted = { ...row('bank', true), date: new Date(2026, 6, 12) };
    assert.equal(reconcileSettlements([row('card'), shifted], since, today).settlements[0].status, 'matched');
    const result = reconcileSettlements([row('card'), { ...shifted, amount: -9999 }], since, today);
    assert.equal(result.settlements[0].status, 'review');
    assert.equal(result.settlements[0].difference, -1);
});
test('one bank settlement cannot be reused by two cards and duplicate candidates stay unresolved', () => {
    const second = { ...row('second'), accountId: 'second' }, bank = { ...row('bank', true), description: 'ישראכרט בע״מ' };
    const result = reconcileSettlements([row('card'), second, bank], since, today);
    assert.equal(result.matchedBank.size, 0);
    assert.ok(result.settlements.every(s => s.status === 'review'));
    assert.equal(reconcileSettlements([row('card'), bank, { ...bank, id: 'duplicate' }], since, today).settlements[0].status, 'review');
});
test('pending, future and old statements stay outside the matching period; zero net needs no bank debit', () => {
    assert.equal(reconcileSettlements([{ ...row('pending'), status: 'pending' }, { ...row('future'), processedDate: new Date(2026, 9, 10) }, { ...row('old'), processedDate: new Date(2026, 4, 10) }], since, today).settlements.length, 0);
    assert.equal(reconcileSettlements([row('purchase'), row('refund', false, 10000)], since, today).settlements[0].status, 'balanced');
});
