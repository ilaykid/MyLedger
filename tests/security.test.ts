import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/redact.js';
import { compileSafeRegex } from '../src/safe-regex.js';
import { parseChatIds } from '../src/notify.js';

test('redacts known secrets and credential-shaped fields', () => {
  const output = redactSecrets(
    'Failed body={"id":"123456789","Sisma":"open-sesame","message":"open-sesame"}',
    ['open-sesame'],
  );
  assert.equal(output.includes('open-sesame'), false);
  assert.equal(output.includes('123456789'), false);
  assert.match(output, /\[REDACTED\]/);
});

test('safe regex accepts finance rules and rejects nested quantifiers', () => {
  assert.equal(compileSafeRegex('סופר(?:מרקט)?').test('סופרמרקט שכונתי'), true);
  assert.throws(() => compileSafeRegex('(a+)+$'), /nested/);
  assert.throws(() => compileSafeRegex('(.*)*'), /nested/);
  assert.throws(() => compileSafeRegex('(a)\\1'), /backreferences/);
});

test('telegram recipients parse from one sealed field, deduped and whitespace-tolerant', () => {
  assert.deepEqual(parseChatIds('123456789'), ['123456789']);
  assert.deepEqual(parseChatIds('123456789,987654321'), ['123456789', '987654321']);
  // A hand-edited list picks up spaces and trailing commas; neither should
  // produce an empty chat id, which Telegram answers with "chat not found".
  assert.deepEqual(parseChatIds(' 123 , 456 ,, '), ['123', '456']);
  assert.deepEqual(parseChatIds('123,123'), ['123']);
  // No recipients means the digest must no-op rather than send into the void.
  assert.deepEqual(parseChatIds(''), []);
  assert.deepEqual(parseChatIds('  ,  '), []);
});
