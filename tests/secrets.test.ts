import test from 'node:test';
import assert from 'node:assert/strict';
import { protect, unprotect } from '../src/secrets.js';

test('DPAPI round trip preserves Unicode and whitespace in synthetic credentials', { skip: process.platform !== 'win32' }, async () => {
  const value = '  synthetic-סיסמה-🔑  ';
  const sealed = await protect(value);
  assert.equal(sealed.includes(value), false);
  assert.equal(await unprotect(sealed), value);
});

test('DPAPI decryption fails closed on malformed ciphertext without echoing it', { skip: process.platform !== 'win32' }, async () => {
  const invalid = 'invalid-ciphertext-fixture';
  await assert.rejects(unprotect('dpapi:' + invalid), (error: Error) => {
    assert.match(error.message, /Could not decrypt/);
    assert.equal(error.message.includes(invalid), false);
    return true;
  });
});
