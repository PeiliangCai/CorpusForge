import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionBudget, S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { PROVIDER_HIGH_LOAD_MESSAGE } from '../../packages/agent/src/extraction-high-load-retry.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from './fixtures/runtime-responses.js';

const busy: ResponsesStep = { sse_error_message: PROVIDER_HIGH_LOAD_MESSAGE };
const summary: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} },
  { name: 'submit_candidate_records', arguments: { summary: 'Synthetic retry fixture only.', reviews: [], links: [], updates: [], summary_complete: true } }] };
const complete: ResponsesStep = { calls: [{ name: 'read_document_blocks', arguments: {} },
  { name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] };

async function run(steps: Parameters<typeof createRuntimeResponsesFixture>[0], options: {
  fixture?: ReturnType<typeof makeEvidenceFixture>; signal?: AbortSignal; maxRequests?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 't1-high-load-retry-'));
  const fixture = options.fixture ?? makeEvidenceFixture();
  const store = new ExtractionStore(join(directory, 'store.sqlite'));
  const scripted = await createRuntimeResponsesFixture(steps, { summaryAssessments: () => store.current(fixture.input.run_id)
    .map(v => ({ record_id: v.record.record_id, expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' })) });
  const budget = new ExtractionBudget(join(directory, 'ledger.json'), scripted.endpoint, Date.now, options.maxRequests ? {
    limits: { ...S4_LIMITS, requests: options.maxRequests },
    authorization: { id: 'a'.repeat(64), source: 'synthetic_local_retry_test', recorded_at: new Date().toISOString() },
  } : {});
  fixture.input.runtime_profile = { ...fixture.input.runtime_profile, provider: scripted.config.provider,
    model_id: scripted.config.modelId, endpoint: scripted.endpoint };
  try {
    const result = await runExtractionDocument({ input: fixture.input, document: fixture.document, catalog: fixture.catalog,
      metadata: fixture.context.metadata, config: scripted.config, profile: developmentProfile(scripted.config.modelId),
      budget, store, directory, strategy: 'baseline', sourceSelectionCondition: 'B0', stopOnBatchFailure: true, signal: options.signal });
    return { result, budget, requests: scripted.requests, versions: store.versions(fixture.input.run_id),
      batches: store.batches(fixture.input.run_id) };
  } finally { await scripted.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('exact busy retries only the current SDK request; saved candidate and completed tools execute once', async () => {
  const fixture = makeEvidenceFixture(), record = fixture.submission;
  const candidate = { source_line_indices: [0], feature_name_raw: record.feature_name_raw, feature_category: record.feature_category,
    evidence_type: record.evidence_type, assertion: record.assertion.value, origin: record.provenance.origin,
    disease_or_lesion: { value: record.disease_or_lesion.value, line_indices: [0] },
    modality: { value: record.modality.value, line_indices: [0] } };
  const saved: ResponsesStep = { calls: [{ name: 'read_document_blocks', arguments: {} },
    { name: 'submit_candidate_records', arguments: { records: [candidate], batch_complete: false } }] };
  const finish: ResponsesStep = { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] };
  const value = await run([saved, busy, finish, summary], { fixture });
  assert.equal(value.result.state, 'completed'); assert.equal(value.result.candidate_count, 1);
  assert.equal(value.versions.length, 2, 'one original save plus the normal summary assessment; no replayed save');
  assert.equal(value.requests.length, 4);
  assert.deepEqual(value.requests[1]!.body, value.requests[2]!.body, 'retry has the exact same completed-tool context');
  assert.equal(value.result.events.filter(event => event.type === 'retry').length, 0);
  const batch = value.batches[0]! as { attempt: number; tool_calls: Array<{ name: string }>; result: { provider_request_retries: unknown[] } };
  assert.equal(batch.attempt, 0); assert.equal(batch.result.provider_request_retries.length, 1);
  assert.equal(batch.tool_calls.filter(call => call.name === 'read_document_blocks').length, 1);
  assert.equal(batch.tool_calls.filter(call => call.name === 'submit_candidate_records').length, 2, 'one upsert and one empty completion');
  assert.equal(value.budget.ledger.requests[1]!.error_code, 'provider_reported_high_load');
  assert.equal(value.budget.totals().conservative_missing_usage_requests, 1);
});

test('persistent exact busy stops at the existing two retries and retains all missing-usage reservations', async () => {
  const value = await run([busy, busy, busy, complete, summary]);
  assert.equal(value.result.state, 'failed'); assert.equal(value.requests.length, 3);
  assert.equal(value.result.events.filter(event => event.type === 'retry').length, 0);
  assert.equal(value.result.coverage.whole_document_summary_complete, false);
  assert.equal(value.budget.totals().conservative_missing_usage_requests, 3);
  assert.equal(value.budget.totals().output_tokens, 3 * S4_LIMITS.response_output_tokens);
});

test('HTTP retries and exact-busy physical retries share the existing two-attempt allowance', async () => {
  const value = await run([{ status: 503 }, busy, busy, complete, summary]);
  assert.equal(value.requests.length, 3); assert.equal(value.result.state, 'failed');
  assert.deepEqual(value.budget.ledger.requests.map(entry => entry.attempt), [0, 1, 1]);
  assert.equal(value.result.events.filter(event => event.type === 'retry').length, 1);
});

test('a later HTTP failure does not add fresh-agent retries after a physical busy retry', async () => {
  const value = await run([busy, { calls: [{ name: 'read_document_blocks', arguments: {} }] }, { status: 503 }, complete, summary]);
  assert.equal(value.requests.length, 3); assert.equal(value.result.state, 'failed');
  assert.equal(value.result.events.filter(event => event.type === 'retry').length, 0);
});

test('unknown, near-match and balance errors remain immediate failures', async () => {
  for (const message of ['unknown synthetic provider error', PROVIDER_HIGH_LOAD_MESSAGE + '.', 'Insufficient balance']) {
    const value = await run([{ sse_error_message: message }, complete, summary]);
    assert.equal(value.requests.length, 1); assert.equal(value.result.state, 'failed');
    assert.equal(value.result.events.filter(event => event.type === 'retry').length, 0);
  }
});

test('unknown model identity is never retried or followed by business tools', async () => {
  const value = await run([{ calls: [{ name: 'read_document_blocks', arguments: {} }], response_model: 'unapproved-other-model' }, complete, summary]);
  assert.equal(value.requests.length, 1); assert.equal(value.budget.ledger.halted, 'response_model_identity_mismatch');
  assert.equal(value.result.candidate_count, 0);
});

test('exact busy after partial SDK output is not replayed', async () => {
  const value = await run([{ ...busy, text: 'Synthetic partial response.', sse_error_after_output: true }, complete, summary]);
  assert.equal(value.requests.length, 1); assert.equal(value.result.state, 'failed');
  assert.equal(value.result.events.filter(event => event.type === 'retry').length, 0);
});

test('request budget exhaustion prevents the next physical busy retry', async () => {
  const value = await run([busy, complete, summary], { maxRequests: 1 });
  assert.equal(value.requests.length, 1); assert.equal(value.budget.totals().requests, 1);
  assert.equal(value.budget.ledger.halted, 'experiment_request_limit');
});

test('cancellation during the busy retry delay prevents another physical request', async () => {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await run(request => {
      if (request.index === 0) timer = setTimeout(() => controller.abort(), 25);
      return busy;
    }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(value.requests.length, 1); assert.equal(value.budget.totals().requests, 1);
    assert.equal(value.result.state, 'cancelled');
  } finally { clearTimeout(timer); }
});
