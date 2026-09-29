import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only an explicit registry E404 means absent; all uncertain reads fail closed.
export function classifyIdentity(result, version, head) {
  if (result.error) throw new Error('Registry lookup could not run');
  let data;
  try { data = JSON.parse(result.stdout); }
  catch { throw new Error('Registry lookup did not return valid JSON'); }
  if (result.status !== 0) {
    if (data?.error?.code === 'E404') return 'absent';
    throw new Error('Registry lookup failed; publication is not safe');
  }
  if (data?.version !== version || data?.gitHead !== head) {
    throw new Error('Published version/gitHead differs from the selected source');
  }
  return 'matching';
}

export async function verifyIdentity(mode, version, head, lookup, delay = () => new Promise(resolve => setTimeout(resolve, 5000))) {
  if (!['before', 'after'].includes(mode)) throw new Error('Expected before or after');
  for (let attempt = 0; attempt < (mode === 'after' ? 5 : 1); attempt++) {
    const identity = classifyIdentity(lookup(), version, head);
    if (mode === 'before' || identity === 'matching') return identity;
    if (attempt < 4) await delay();
  }
  throw new Error('Published identity not visible after bounded verification; inspect before retrying');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error('Cannot determine source commit');
  const identity = await verifyIdentity(process.argv[2], version, git.stdout.trim(), () =>
    spawnSync('npm', ['view', `${name}@${version}`, 'version', 'gitHead', '--json', '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=15000'], { encoding: 'utf8', timeout: 20000 }));
  console.log(`Registry identity: ${identity}`);
  if (process.argv[2] === 'before') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${identity === 'absent'}\n`);
  }
}
