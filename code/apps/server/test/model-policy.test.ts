import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelConfig, ExtractionBudget, createExtractionSession, promptExtractionSession } from '@t1/agent';
import { workbenchModelPolicy } from '../src/model-policy.js';
import { createRuntimeResponsesFixture } from '../../../tests/extraction/fixtures/runtime-responses.js';

const model = { provider: 'agicto', baseUrl: 'https://api.agicto.cn/v1', modelId: 'gpt-6-luna' };
test('ordinary exact deployment choices preserve the supplier evidence and do not generalize across provider, endpoint or model', async () => {
  const policy = workbenchModelPolicy(model).responseModelAliasPolicy!;
  assert.deepEqual(policy.exact_pairs, [
    { requested_model: 'gpt-6-luna', response_model: 'igpt-6-luna' },
    { requested_model: 'igpt-6-luna', response_model: 'gpt-6-luna' },
    { requested_model: 'gpt-6-luna', response_model: 'data-zone-standard-gpt-6-luna' },
  ]);
  assert.equal(policy.source, 'code/config/workbench-response-model-policy.json');
  const choice = JSON.parse(await readFile('config/workbench-response-model-policy.json', 'utf8'));
  assert.equal(choice.additional_pair_authority.supplier_confirmed, false); assert.equal(choice.additional_pair_authority.weight_identity_verified, false);
  assert.equal(createHash('sha256').update(await readFile(choice.prior_supplier_confirmation.path)).digest('hex'), choice.prior_supplier_confirmation.sha256);
  for (const override of [{ provider: 'other' }, { baseUrl: 'https://example.invalid/v1' }, { modelId: 'gpt-6-astra' }])
    assert.equal(workbenchModelPolicy({ ...model, ...override }).responseModelAliasPolicy, undefined);
});

test('installed SDK accepts the two exact ordinary returned aliases and stops an unlisted deployment name without a follow-up request', async () => {
  const root = await mkdtemp(resolve('runtime-data/current-model-policy-'));
  try {
    for (const [i, name] of ['igpt-6-luna', 'data-zone-standard-gpt-6-luna', 'data-zone-standard-gpt-6-luna-v2'].entries()) {
      const server = await createRuntimeResponsesFixture([{ text: 'Synthetic exact-label transport only.', response_model: name }]);
      try {
        const config = new ModelConfig('loopback-synthetic', server.endpoint, model.modelId, 'not-a-real-key');
        const budget = new ExtractionBudget(resolve(root, i + '-ledger.json'), server.endpoint, Date.now,
          { responseModelAliasPolicy: workbenchModelPolicy(model).responseModelAliasPolicy });
        const created = await createExtractionSession(config, workbenchModelPolicy(model).profile, [], resolve(root, String(i)), budget, 'ordinary-exact-local');
        const result = await promptExtractionSession(created, 'Local synthetic transport fixture; no medical approval.', budget);
        assert.equal(server.requests.length, 1); assert.equal(server.requests[0]!.body.model, 'gpt-6-luna');
        const entry = budget.ledger.requests[0]!; assert.equal(entry.provider_response_model, name);
        if (i < 2) { assert.equal(result.error, undefined); assert.equal(entry.response_model_identity_status, 'confirmed_alias'); }
        else {
          assert.equal(result.error?.code, 'response_model_identity_mismatch'); assert.equal(entry.response_model_identity_status, 'mismatch');
          assert.throws(() => budget.begin('gpt-6-luna', 'must-not-send-next', 0, '{}', 100), /response_model_identity_mismatch/);
        }
      } finally { await server.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
