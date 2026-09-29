import assert from 'node:assert/strict';
import { classifyIdentity, verifyIdentity } from '../.github/scripts/npm-identity.mjs';

const head = 'a'.repeat(40);
const matching = { status: 0, stdout: JSON.stringify({ version: '0.1.6', gitHead: head }) };
const absent = { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) };
assert.equal(classifyIdentity(matching, '0.1.6', head), 'matching');
assert.equal(classifyIdentity(absent, '0.1.6', head), 'absent');
for (const result of [
  { status: 0, stdout: '{}' },
  { status: 0, stdout: JSON.stringify({ version: '0.1.5', gitHead: head }) },
  { status: 0, stdout: JSON.stringify({ version: '0.1.6', gitHead: 'b'.repeat(40) }) },
  { status: 1, stdout: JSON.stringify({ error: { code: 'E401' } }) },
  { status: 1, stdout: JSON.stringify({ error: { code: 'ETIMEDOUT' } }) },
  { status: 1, stdout: '' },
  { status: 0, stdout: '[]' },
  { error: new Error('spawn failure'), stdout: '' },
]) assert.throws(() => classifyIdentity(result, '0.1.6', head));
assert.equal(await verifyIdentity('before', '0.1.6', head, () => absent), 'absent');
assert.equal(await verifyIdentity('before', '0.1.6', head, () => matching), 'matching');
let reads = 0;
assert.equal(await verifyIdentity('after', '0.1.6', head, () => ++reads < 3 ? absent : matching, async () => {}), 'matching');
assert.equal(reads, 3);
reads = 0;
await assert.rejects(verifyIdentity('after', '0.1.6', head, () => { reads++; return absent; }, async () => {}));
assert.equal(reads, 5);
await assert.rejects(verifyIdentity('invalid', '0.1.6', head, () => matching));
console.log('PASS: immutable npm identity, fail-closed reads and bounded postpublish recovery');
