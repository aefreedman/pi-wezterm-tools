import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
assert.match(workflow, /release:\s+types: \[published\]/);
assert.match(workflow, /workflow_dispatch:\s+inputs:\s+tag:/);
assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \|\| inputs\.tag \}\}/);
assert.match(workflow, /ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/);
assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' \|\| !github\.event\.release\.prerelease/);
assert.match(workflow, /id-token: write/);
assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|secrets\.|GITHUB_SHA/);
const block = workflow.split('      - name: Verify selected tag is the package version tag\n')[1].split('      - run: npm ci')[0];
const script = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const bash = process.env.PI_WEZTERM_TEST_BASH?.trim() || 'bash';
const mocks = `node() { printf '%s\\n' "$MOCK_VERSION"; }
git() { if [[ "$*" == 'rev-parse HEAD' ]]; then printf '%s\\n' "$MOCK_HEAD"; else printf '%s\\n' "$MOCK_TAG_HEAD"; fi; }
`;
for (const event of ['release', 'workflow_dispatch']) {
  for (const [tag, version, tagHead, success] of [
    ['v0.1.6', '0.1.6', head, true],
    ['', '0.1.6', head, false],
    ['v0.1.5', '0.1.6', head, false],
    ['v0.1.6', '0.1.6', 'b'.repeat(40), false],
    ['v0.1.6-beta', '0.1.6-beta', head, false],
  ]) {
    const result = spawnSync(bash, ['-c', mocks + script], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: event, RELEASE_TAG: tag, MOCK_VERSION: version, MOCK_HEAD: head, MOCK_TAG_HEAD: tagHead },
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, success, `${event} ${tag}: ${result.stderr}`);
  }
}
console.log('PASS: published-release/manual tag routing and wrong/empty tag, commit and prerelease rejection');
