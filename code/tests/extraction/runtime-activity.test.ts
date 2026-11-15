import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createExtractionSession, promptExtractionSession, developmentProfile, type ExtractionActivity } from '../../packages/agent/src/extraction-pi.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { buildArticleScope, planExtractionBatches } from '../../packages/agent/src/article-scope.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { PROVIDER_HIGH_LOAD_MESSAGE } from '../../packages/agent/src/extraction-high-load-retry.js';

test('installed SDK records waiting before first stream event, real tool identity and exactly one end per request', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/runtime-activity-')), store = new ExtractionStore(':memory:');
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const server = await createRuntimeResponsesFixture(request => { if (!request.index) { entered(); return { response_gate: gate, calls: [{ name: 'read_document_blocks', arguments: {} }] }; } return { text: 'Synthetic done.' }; });
  const f = makeEvidenceFixture(['CT shows a round nodule.']), article = buildArticleScope(f.document); store.create(f.input, f.context.metadata);
  const tools = new ExtractionTools(f.context, planExtractionBatches(f.document, article)[0]!, article, store, 'batch_lines'), activities: ExtractionActivity[] = [];
  try {
    const budget = new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), created = await createExtractionSession(server.config, developmentProfile(server.config.modelId), tools.definitions(), directory, budget, 'activity-gate', 0, 8, undefined, undefined, { onActivity: a => { activities.push(a); } });
    const pending = promptExtractionSession(created, 'Synthetic loopback tool lifecycle.', budget); await ready;
    assert.equal(activities[0]!.type, 'request_started'); assert.equal(activities.some(a => a.type === 'request_response'), false, 'HTTP headers are not a provider stream event');
    release(); const result = await pending; assert.equal(result.error, undefined);
    assert.equal(activities.filter(a => a.type === 'request_started').length, 2); assert.equal(activities.filter(a => a.type === 'request_finished').length, 2);
    const start = activities.find(a => a.type === 'tool_started')!, end = activities.find(a => a.type === 'tool_finished')!;
    assert.equal(start.tool_name, 'read_document_blocks'); assert.equal(start.tool_call_id, end.tool_call_id); assert.equal(start.started_at, end.started_at);
    assert.equal(activities.find(a => a.type === 'request_response')!.request_id, activities[0]!.request_id);
    assert.doesNotMatch(JSON.stringify(activities), /CT shows|line_indices|exact_quote|local-placeholder/);
  } finally { release?.(); store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('installed SDK deadline ends a zero-event response without inventing received content', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/runtime-activity-timeout-')), server = await createRuntimeResponsesFixture([{ stall_after_headers: true }]), activities: ExtractionActivity[] = [];
  try {
    const budget = new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), created = await createExtractionSession(server.config, developmentProfile(server.config.modelId), [], directory, budget, 'activity-timeout', 0, 8, undefined, 150, { onActivity: a => { activities.push(a); } });
    const result = await promptExtractionSession(created, 'Synthetic timeout.', budget);
    assert.equal(result.error!.code, 'request_time_limit'); assert.equal(activities.filter(a => a.type === 'request_response').length, 0);
    const ends = activities.filter(a => a.type === 'request_finished'); assert.equal(ends.length, 1); assert.equal(ends[0]!.outcome, 'failed'); assert.equal(ends[0]!.error_code, 'request_time_limit'); assert.ok(ends[0]!.finished_at);
    assert.equal(budget.totals().requests, 1); assert.equal(budget.totals().conservative_missing_usage_requests, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('physical high-load retry emits bounded failure/retry/start metadata without extra SDK retries', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/runtime-activity-load-')), server = await createRuntimeResponsesFixture([{ sse_error_message: PROVIDER_HIGH_LOAD_MESSAGE }, { text: 'Synthetic recovered.' }]), activities: ExtractionActivity[] = [];
  try {
    const budget = new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), created = await createExtractionSession(server.config, developmentProfile(server.config.modelId), [], directory, budget, 'activity-load', 0, 8, undefined, undefined, { onActivity: a => { activities.push(a); } });
    const result = await promptExtractionSession(created, 'Synthetic high load.', budget); assert.equal(result.error, undefined);
    assert.equal(server.requests.length, 2); assert.deepEqual(activities.filter(a => a.type === 'request_started').map(a => a.attempt), [0, 1]);
    assert.equal(activities.filter(a => a.type === 'retry_scheduled').length, 1); assert.deepEqual(activities.filter(a => a.type === 'request_finished').map(a => a.outcome), ['failed', 'response_received']);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('runner records first batch exhaustion and later real completion without changing existing continuation or task truth', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/runtime-activity-run-')), store = new ExtractionStore(':memory:'), f = makeEvidenceFixture(['CT shows a round nodule.', 'CT shows a smooth margin.']);
  const server = await createRuntimeResponsesFixture(request => request.index < 3 ? { status: 503 } : store.snapshot(f.input.run_id).state === 'extracting' ?
    { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] } :
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: { summary: 'Synthetic metadata check.', reviews: [], links: [], updates: [], summary_complete: true } }] });
  try {
    const budget = new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata, config: server.config, profile: developmentProfile(server.config.modelId), budget, store, directory: resolve(directory, 'run'), strategy: 'baseline', batchOptions: { maxBlocks: 1, contextBlocks: 0 }, prefillBatchSource: true });
    const events = result.events; assert.deepEqual(events.filter(e => e.type === 'batch_started').map(e => (e.detail as any).batch_index), [1, 2]);
    assert.equal(events.filter(e => e.type === 'batch_failed').length, 1); assert.equal(events.filter(e => e.type === 'retry').length, 2);
    const activity = events.filter(e => e.type === 'run_activity').map(e => (e.detail as any).activity as ExtractionActivity);
    assert.equal(activity.filter(a => a.type === 'request_started').length, budget.totals().requests); assert.equal(activity.filter(a => a.type === 'request_finished').length, budget.totals().requests);
    assert.equal(result.task_processing_complete, false); assert.ok(result.coverage.failed_source_block_ids.length > 0); assert.equal(budget.ledger.halted, null); assert.equal(result.medical_quality_approved, false);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
