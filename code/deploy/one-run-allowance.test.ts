import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { ExtractionBudget, ModelConfig, S4_LIMITS } from '@t1/agent';
import type { RunInput } from '@t1/contracts';
import { unavailableMedicalCatalog } from '../apps/server/src/workflow.js';
import { assertContainerPlan, containerResponseModelAliasPolicy, ContainerOneRunAllowance, type ContainerRunPlan } from './one-run-allowance.js';

test('one-container admission binds source/scope, survives restart, starts clock at HTTP and closes remainder without requests', async () => {
  const root = await mkdtemp(resolve('runtime-data/s7-allowance-offline-')), pin = resolve(root, 'pin.txt'), directory = resolve(root, 'workbench/runs/test');
  await mkdir(directory, { recursive: true }); await writeFile(pin, 'original');
  let now = 1_000;
  const scope = { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] }, catalog_version: unavailableMedicalCatalog.catalog_version, matching_policy_version: 'exact-explicit-synonyms-1' } as const;
  const plan = { schema_version: 's7-one-container-run-1', plan_id: 'offline-guard-test-not-authorization',
    authorization: { authorized_runs: 1, scope: 'S7_single_container_deployment_reverification', observed_at: '1970-01-01T00:00:01.000Z' }, input: { document_id: 'engineering', sha256: 'a'.repeat(64) },
    model: { provider: 'agicto', endpoint: 'https://api.agicto.cn/v1', model_id: 'gpt-6-luna', reasoning_effort: 'medium' },
    hard_stop_utc: '1970-01-01T00:40:00.000Z', limits: { ...S4_LIMITS, requests: 40, input_tokens: 1_000_000, output_tokens: 60_000, seconds: 1800, document_seconds: 1800, batch_responses: 16 },
    scope, code_sha256: { [relative(process.cwd(), pin)]: createHash('sha256').update('original').digest('hex') } } as unknown as ContainerRunPlan;
  const config = new ModelConfig('agicto', 'https://api.agicto.cn/v1', 'gpt-6-luna', 'offline-dummy-no-network');
  const input = { file_sha256: plan.input.sha256, scope: plan.scope, run_id: 'offline-test-run' } as RunInput;
  const allowance = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), root, () => now);
  try {
    assertContainerPlan(plan); assert.equal(allowance.available(), true);
    assert.throws(() => allowance.prepare({ ...input, file_sha256: 'c'.repeat(64) }, directory), /input_or_scope_not_authorized/);
    assert.equal(allowance.available(), true);
    allowance.prepare(input, directory);
    assert.equal(allowance.budget!.totals().requests, 0); assert.equal(allowance.remainingMs(), 1800_000);
    assert.equal(allowance.available(), false); assert.throws(() => allowance.prepare(input, directory), /single_container_allowance_closed/);
    const restarted = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), root, () => now);
    assert.equal(restarted.available(), false);
    now += 1800_001; assert.throws(() => allowance.remainingMs(), /experiment_time_limit/);
    allowance.close('offline_guard_test_finished');
    const saved = JSON.parse(await readFile(resolve(root, 'allowance.json'), 'utf8'));
    assert.equal(saved.closed, true); assert.equal(saved.unused_allowance_closed, true);
    assert.equal(allowance.budget!.totals().requests, 0);
    const lateDirectory = resolve(root, 'late'), lateRun = resolve(lateDirectory, 'runs/late'); await mkdir(lateRun, { recursive: true });
    const shortWindow = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), lateDirectory, () => Date.parse(plan.hard_stop_utc) - 1000);
    assert.equal(shortWindow.available(), true); shortWindow.prepare({ ...input, run_id: 'late-test' }, lateRun);
    assert.equal(shortWindow.budget!.wallClockSeconds, 1); shortWindow.close('offline_short_window_closed');
    const tooLate = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), resolve(root, 'past'), () => Date.parse(plan.hard_stop_utc));
    assert.equal(tooLate.available(), false);
    const latest = new ContainerOneRunAllowance({ ...plan, latest_admission_utc: '1970-01-01T00:00:02.000Z' }, 'b'.repeat(64), config, process.cwd(), resolve(root, 'late-admission'), () => 2001);
    assert.equal(latest.available(), false);
    assert.throws(() => assertContainerPlan({ ...plan, limits: { ...plan.limits, transient_retries: 3 } }), /invalid_container_verification_limit/);
    await writeFile(pin, 'changed');
    assert.throws(() => new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), root), /pin_changed/);
  } finally { allowance.close('offline_test_cleanup'); await rm(root, { recursive: true, force: true }); }
});

test('a one-run trial retains the ordinary exact choices without duplicate aliases or wildcard expansion', async () => {
  const root = await mkdtemp(resolve('runtime-data/s7-trial-alias-offline-'));
  const model = { provider: 'agicto', endpoint: 'https://api.agicto.cn/v1', model_id: 'gpt-6-luna', reasoning_effort: 'medium' } as const;
  const config = new ModelConfig(model.provider, model.endpoint, model.model_id, 'offline-dummy-no-network');
  const plan: ContainerRunPlan = { schema_version: 's7-one-container-run-1', plan_id: 'offline-exact-name', model,
    authorization: { authorized_runs: 1, scope: 'S7_single_container_deployment_reverification', observed_at: '2026-11-11T09:03:55Z' },
    input: { document_id: 'IN04', sha256: 'a'.repeat(64) }, hard_stop_utc: '2026-11-11T10:03:55Z',
    limits: { ...S4_LIMITS, requests: 24, input_tokens: 600_000, output_tokens: 32_000, seconds: 900, document_seconds: 900, batch_responses: 16 },
    scope: { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] },
      catalog_version: unavailableMedicalCatalog.catalog_version, matching_policy_version: 'exact-explicit-synonyms-1' },
    code_sha256: { 'deploy/one-run-allowance.ts': 'a'.repeat(64) },
    trial_response_model_alias: { basis: 'user_accepted_for_this_trial_only', recorded_at: '2026-11-11T09:03:55Z',
      authority_path: 'docs/acceptance/continuation-2026-11-11/authority.json', authority_sha256: 'b'.repeat(64),
      requested_model: 'gpt-6-luna', response_model: 'data-zone-standard-gpt-6-luna', supplier_confirmed: false, weight_identity_verified: false } };
  try {
    const original = containerResponseModelAliasPolicy({ ...plan, trial_response_model_alias: undefined }, config)!;
    const accepted = containerResponseModelAliasPolicy(plan, config)!;
    assert.deepEqual(accepted.exact_pairs, original.exact_pairs);
    assert.equal(original.exact_pairs.some(pair => pair.response_model === 'data-zone-standard-gpt-6-luna'), true);
    for (const [index, name] of ['gpt-6-luna', 'igpt-6-luna', 'data-zone-standard-gpt-6-luna', 'data-zone-standard-gpt-6-luna-v2', 'iigpt-6-luna'].entries()) {
      const budget = new ExtractionBudget(resolve(root, index + '.json'), 'http://127.0.0.1:1/v1', Date.now, { responseModelAliasPolicy: accepted });
      const entry = budget.begin('gpt-6-luna', 'offline-no-dispatch', 0, '{}', 100); budget.observeResponseModel(entry, name, 'response.completed');
      assert.equal(entry.provider_response_model, name);
      assert.equal(entry.response_model_identity_status, index === 0 ? 'matched' : index < 3 ? 'confirmed_alias' : 'mismatch');
      assert.equal(budget.ledger.halted, index < 3 ? null : 'response_model_identity_mismatch');
    }
    const ordinary = new ExtractionBudget(resolve(root, 'ordinary.json'), 'http://127.0.0.1:1/v1', Date.now, { responseModelAliasPolicy: original });
    const entry = ordinary.begin('gpt-6-luna', 'ordinary-policy-no-dispatch', 0, '{}', 100);
    ordinary.observeResponseModel(entry, 'data-zone-standard-gpt-6-luna', 'response.completed'); assert.equal(entry.response_model_identity_status, 'confirmed_alias');
    assert.throws(() => containerResponseModelAliasPolicy(plan, new ModelConfig('other-provider', model.endpoint, model.model_id, 'offline')), /config_differs/);
    for (const patch of [{ response_model: 'other-gpt-6-luna' }, { requested_model: 'gpt-6-astra' }, { supplier_confirmed: true }, { authority_path: 'docs/acceptance/../authority.json' }])
      assert.throws(() => assertContainerPlan({ ...plan, trial_response_model_alias: { ...plan.trial_response_model_alias, ...patch } } as ContainerRunPlan), /invalid_container_trial_response_alias/);
    assert.deepEqual(containerResponseModelAliasPolicy({ ...plan, trial_response_model_alias: undefined }, config), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
