import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionStore, RunStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { configuredWorkflowRunner } from '../src/workflow-runner.js';
import { modelProfile } from '../src/workbench-models.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';
import type { WorkbenchModelProfile } from '../../../packages/contracts/src/workbench.js';

const input = { model_id: 'synthetic-model', api: 'openai-completions' as const, reasoning_effort: 'none' as const, context_window: 32768, max_output_tokens: 4096 };
const initial = modelProfile('agicto', { ...input, model_id: 'gpt-6-luna', api: 'openai-responses', reasoning_effort: 'medium', context_window: 1050000, max_output_tokens: 8192 }, 'server');
const until = async (condition: () => boolean) => { for (let n = 0; n < 300; n++) { if (condition()) return; await delay(10); } throw new Error('model_fixture_timeout'); };

test('only validated immutable server profiles are stored; deduplication, run replay and legacy hashes survive restart', async () => {
  const directory = await mkdtemp(resolve('runtime-data/model-config-test-')), database = resolve(directory, 'db.sqlite');
  let store = new ExtractionStore(database), legacy = new RunStore(':memory:');
  const fixture = await controlledFixture({ delayMs: 1 }); fixture.runner!.default_model_profile = initial;
  let workflow = new WorkbenchWorkflow(store, { ...fixture, directory }), app = buildApp(legacy, undefined, workflow);
  try {
    await app.ready(); assert.equal((await app.inject('/api/workbench/models')).json().default_profile_id, initial.profile_id);
    const add = await app.inject({ method: 'POST', url: '/api/workbench/models', payload: input }); assert.equal(add.statusCode, 200);
    const profile = add.json().profile as WorkbenchModelProfile;
    assert.equal(profile.configuration_source, 'user'); assert.equal(profile.provider, 'agicto');
    assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/models', payload: input })).json().profile.profile_id, profile.profile_id);
    assert.equal(workflow.models().profiles.length, 2);
    for (const value of [{ ...input, api: 'arbitrary' }, { ...input, reasoning_effort: 'max' }, { ...input, context_window: 0 }, { ...input, max_output_tokens: 8193 },
      { ...input, endpoint: 'https://other.invalid' }, { ...input, api_key: 'placeholder' }, { ...input, requests: 999 }, { ...input, model_id: 'bad model' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/models', payload: value })).statusCode, 400);
    }
    assert.equal(workflow.models().profiles.length, 2);
    const paper = (await workflow.papers()).find(paper => paper.id === 'L01')!, scope = workflow.scopeCatalog().default_scope;
    const start = (payload: Record<string, unknown>, key: string) => app.inject({ method: 'POST', url: `/api/workbench/papers/${paper.id}/runs`, payload, headers: { 'x-t1-request-id': key } });
    for (const extra of [{ api: 'openai-responses' }, { model_id: 'unlisted' }, { endpoint: 'https://other.invalid' }, { max_requests: 1000 }])
      assert.equal((await start({ scope, model_profile_id: profile.profile_id, ...extra }, 'reject-model-0001')).statusCode, 400);
    assert.equal((await start({ scope, model_profile_id: 'model-' + 'f'.repeat(32) }, 'unknown-model-0001')).statusCode, 404);
    const first = (await start({ scope, submission: { kind: 'single' }, model_profile_id: profile.profile_id }, 'saved-model-0001')).json().run;
    assert.equal(first.model_id, input.model_id); assert.deepEqual(first.model_profile, profile);
    assert.equal((await start({ scope, submission: { kind: 'single' }, model_profile_id: initial.profile_id }, 'saved-model-0001')).statusCode, 409);
    const old = (await start({ scope }, 'legacy-model-0001')).json().run;
    const canonical = JSON.stringify({ paper_id: paper.id, scope }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    assert.equal(store.db.prepare('SELECT payload_sha256 FROM workbench_requests WHERE request_id=?').get('legacy-model-0001')!.payload_sha256, createHash('sha256').update(canonical).digest('hex'));
    await workflow.waitForIdle();
    const before = (await workflow.runs()).length;
    await app.close(); legacy.close(); store.close();
    store = new ExtractionStore(database); legacy = new RunStore(':memory:');
    workflow = new WorkbenchWorkflow(store, { ...fixture, directory }); app = buildApp(legacy, undefined, workflow); await app.ready();
    assert.deepEqual(workflow.models().profiles.find(value => value.profile_id === profile.profile_id), profile);
    assert.equal((await workflow.start(paper.id, scope, 'saved-model-0001', { kind: 'single' }, profile.profile_id)).run.run_id, first.run_id);
    assert.equal((await workflow.start(paper.id, scope, 'legacy-model-0001')).run.run_id, old.run_id);
    assert.equal((await workflow.runs()).length, before); assert.deepEqual((await workflow.runDetail(first.run_id)).run.model_profile, profile);
  } finally { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('two execution slots and FIFO keep each admitted profile while later selections and returned objects change', async () => {
  const directory = await mkdtemp(resolve('runtime-data/model-queue-test-')), store = new ExtractionStore(resolve(directory, 'db.sqlite'));
  const fixture = await controlledFixture({ delayMs: 1 }), entered: Array<{ id: string; profile: WorkbenchModelProfile }> = [], release = new Map<string, () => void>();
  fixture.runner = { controlled: true, provider: initial.provider, model_id: initial.model_id, default_model_profile: initial, execute: async context => {
    entered.push({ id: context.input.run_id, profile: context.model_profile! });
    context.store.transition(context.input.run_id, 'extracting');
    await new Promise<void>(accept => { release.set(context.input.run_id, accept); context.signal.addEventListener('abort', () => accept(), { once: true }); });
    if (!context.signal.aborted) { context.store.transition(context.input.run_id, 'reconciling'); context.store.transition(context.input.run_id, 'completed'); }
    return {};
  } };
  const workflow = new WorkbenchWorkflow(store, { ...fixture, directory });
  try {
    await workflow.initialize(); const a = workflow.addModel(input).profile, b = workflow.addModel({ ...input, model_id: 'other-synthetic' }).profile;
    const scope = workflow.scopeCatalog().default_scope;
    const first = (await workflow.start('L01', scope, 'queue-model-0001', { kind: 'single' }, a.profile_id)).run;
    const second = (await workflow.start('L01', scope, 'queue-model-0002', { kind: 'single' }, b.profile_id)).run;
    const third = (await workflow.start('L01', scope, 'queue-model-0003', { kind: 'single' }, a.profile_id)).run;
    a.model_id = 'mutated-browser-object'; fixture.runner.default_model_profile = b;
    await until(() => entered.length === 2); assert.deepEqual(entered.map(value => value.id), [first.run_id, second.run_id]);
    assert.equal((await workflow.runs(third.run_id))[0]!.state, 'queued'); assert.equal(workflow.maxConcurrentRuns, 2);
    release.get(first.run_id)!(); await until(() => entered.length === 3);
    assert.equal(entered[2]!.id, third.run_id); assert.equal(entered[2]!.profile.model_id, input.model_id);
    assert.deepEqual(entered.map(value => value.profile.model_id), [input.model_id, b.model_id, input.model_id]);
    release.get(second.run_id)!(); release.get(third.run_id)!(); await workflow.waitForIdle();
    assert.equal((await workflow.start('L01', scope, 'queue-model-0003', { kind: 'single' }, third.model_profile!.profile_id)).run.run_id, third.run_id);
    assert.equal(entered.length, 3);
  } finally { for (const accept of release.values()) accept(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP profile selection reaches installed Pi SDK request model, protocol and reasoning without external network calls', { timeout: 60000 }, async context => {
  const directory = await mkdtemp(resolve('runtime-data/model-sdk-test-')), store = new ExtractionStore(resolve(directory, 'db.sqlite')), legacy = new RunStore(':memory:');
  const fixture = await controlledFixture({ delayMs: 1 });
  const parse = fixture.parse!;
  fixture.parse = async (...args) => {
    const document = await parse(...args);
    // This test supplies a synthetic parser contract to exercise transport only.
    // Old retained IR lacks the current guard; no PDF fidelity claim is made.
    document.parser.config = { ...document.parser.config, font_glyph_guard_version: 'sparse-embedded-font-no-unicode-1', synthetic_transport_fixture_no_fidelity_claim: true };
    return document;
  };
  const runner = configuredWorkflowRunner({ T1_WORKBENCH_MODEL_ENABLED: 'true', T1_MODEL_PROVIDER: 'agicto', T1_MODEL_BASE_URL: 'https://api.agicto.cn/v1', T1_MODEL_ID: 'gpt-6-luna', T1_MODEL_API_KEY: 'synthetic-placeholder-only' })!;
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  context.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(new URL(request.url).origin, 'https://api.agicto.cn');
    captured.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
    return Response.json({ error: { message: 'Synthetic controlled SDK rejection; no external network or extraction result.' } }, { status: 400 });
  });
  const workflow = new WorkbenchWorkflow(store, { ...fixture, runner, directory }), app = buildApp(legacy, undefined, workflow);
  try {
    await app.ready(); const scope = workflow.scopeCatalog().default_scope;
    for (const api of ['openai-responses', 'openai-completions'] as const) for (const reasoning_effort of ['none', 'medium'] as const) {
      const model_id = `synthetic-${api}-${reasoning_effort}`;
      const profile = (await app.inject({ method: 'POST', url: '/api/workbench/models', payload: { ...input, model_id, api, reasoning_effort } })).json().profile;
      const start = await app.inject({ method: 'POST', url: '/api/workbench/papers/L01/runs', payload: { scope, model_profile_id: profile.profile_id } });
      assert.equal(start.statusCode, 202); const run = start.json().run; await workflow.waitForIdle();
      const requests = captured.filter(value => value.body.model === model_id); assert.ok(requests.length > 0, `${model_id} must reach the actual SDK fetch: ${JSON.stringify((await workflow.runs(run.run_id))[0])}`);
      for (const request of requests) {
        assert.equal(request.path, api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions');
        const effort = api === 'openai-responses' ? (request.body.reasoning as { effort?: string } | undefined)?.effort : request.body.reasoning_effort;
        assert.equal(effort, reasoning_effort === 'none' ? undefined : 'medium');
        if (reasoning_effort === 'none') assert.equal(request.body.reasoning, undefined);
        assert.equal(request.body.max_output_tokens ?? request.body.max_completion_tokens ?? request.body.max_tokens, 4096);
      }
      const ledger = JSON.parse(await readFile(resolve(directory, 'runs', run.run_id, 'request-ledger.json'), 'utf8'));
      assert.deepEqual([ledger.limits.requests, ledger.limits.input_tokens, ledger.limits.output_tokens, ledger.limits.seconds], [80, 2000000, 120000, 1800]);
      assert.equal(ledger.response_model_alias_policy, undefined);
      assert.equal((await workflow.runDetail(run.run_id)).run.model_profile!.profile_id, profile.profile_id);
      const batches = JSON.parse(await readFile(resolve(directory, 'runs', run.run_id, 'batch-plan.json'), 'utf8'));
      const audit = JSON.parse(await readFile(resolve(directory, 'runs', run.run_id, batches[0].batch_id + '-attempt-0.json'), 'utf8'));
      assert.equal(audit.audit.model_capacity_source, 'user_configured_local_limits_not_verified_supplier_capacity');
      assert.equal(audit.audit.application_context_estimate_limit, 32768 - 4096);
    }
    for (const original of [true, false]) {
      const profile = original ? runner.default_model_profile! : workflow.addModel({ ...input, model_id: 'gpt-6-luna' }).profile;
      const run = (await workflow.start('L01', scope, undefined, { kind: 'single' }, profile.profile_id)).run; await workflow.waitForIdle();
      const ledger = JSON.parse(await readFile(resolve(directory, 'runs', run.run_id, 'request-ledger.json'), 'utf8'));
      assert.equal(Boolean(ledger.response_model_alias_policy), original, 'only the original server Luna profile retains its exact alias policy');
    }
  } finally { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
