import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

test('the actual operator driver rejects absent, inconsistent or changed trial authority before Docker or provider access', async () => {
  const root = await mkdtemp(resolve('runtime-data/s7-authority-binding-'));
  const authority = relative(process.cwd(), resolve(root, 'authority.json'));
  const input = relative(process.cwd(), resolve(root, 'input.pdf'));
  const sha = value => createHash('sha256').update(value).digest('hex');
  await writeFile(input, 'synthetic-no-model'); await writeFile(authority, '{"synthetic":true}\n');
  const digest = sha('{"synthetic":true}\n');
  try {
    for (const [index, hostPins] of [undefined, { [authority]: '0'.repeat(64) }, { [authority]: digest }].entries()) {
      if (index === 2) await writeFile(authority, '{"synthetic":"changed"}\n');
      const plan = { plan_id: 'offline-binding-check', input: { path: input, sha256: sha('synthetic-no-model') }, evidence_directory: relative(process.cwd(), root),
        trial_response_model_alias: { authority_path: authority, authority_sha256: digest }, host_evidence_sha256: hostPins };
      const path = resolve(root, 'plan-' + index + '.json'); await writeFile(path, JSON.stringify(plan));
      const result = spawnSync(process.execPath, ['deploy/run-real-verification.mjs', 'check', path], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, index < 2 ? /trial alias authority must be pinned/ : /host evidence pin changed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
