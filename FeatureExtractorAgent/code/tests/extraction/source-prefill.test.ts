import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionBudget, S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { buildArticleScope, planExtractionBatches } from '../../packages/agent/src/article-scope.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { selectSourceBlocks } from '../../packages/agent/src/source-selection.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from './fixtures/runtime-responses.js';

const statement = { source_unit_ids: ['su-000001'], feature_name_raw: 'spiculation', feature_category: 'margin',
  evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' };
const finish: ResponsesStep = { calls: [{ name: 'submit_candidate_records', arguments: { records: [statement], batch_complete: true } }] };
const context: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} }] };
const read: ResponsesStep = { calls: [{ name: 'read_document_blocks', arguments: {} }] };
const summary: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} },
  { name: 'submit_candidate_records', arguments: { summary: 'Synthetic SDK verification only.', reviews: [], links: [], updates: [], summary_complete: true } }] };

test('host preparation uses identical tool projections and records neither a model call nor completed blocks', async () => {
  const fixture = makeEvidenceFixture(['We observed spiculation on CT in lung cancer, measuring 9 mm.', 'Another original statement.']);
  const store = new ExtractionStore(':memory:'); store.create(fixture.input, fixture.context.metadata); store.transition(fixture.input.run_id, 'extracting');
  const article = buildArticleScope(fixture.document), batch = planExtractionBatches(fixture.document, article)[0]!;
  const tools = new ExtractionTools({ ...fixture.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, batch, article, store, 'batch_lines');
  try {
    const prepared = await tools.prepareSourcePrefill();
    assert.equal(tools.readBlocks.size, 0); assert.equal(tools.completed, false); assert.equal(tools.calls.length, 0);
    assert.equal(store.events(fixture.input.run_id).some(e => e.type === 'model_tool_argument_shape' || e.type === 'tool'), false);
    const projected = JSON.parse(prepared.content);
    const definitions = tools.definitions(), decode = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content.filter(c => c.type === 'text').map(c => c.text).join(''));
    for (const [name, key] of [['get_document_context', 'context'], ['read_document_blocks', 'source']] as const) {
      const tool = definitions.find(d => d.name === name)!;
      const result = await tool.execute('comparison-' + key, {}, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
      assert.deepEqual(projected[key], decode(result));
    }
    tools.readBlocks.clear();
    await assert.rejects(tools.invoke('submit_candidate_records', { ...tools.ids, records: [], batch_complete: true }, 'no-exposure'), /batch_completion_requires_all_assigned_blocks_read/);
    prepared.acknowledgeExposure(); prepared.acknowledgeExposure();
    assert.equal(tools.completed, false); assert.equal(tools.readBlocks.size, 2);
    const receipts = store.events(fixture.input.run_id).filter(e => e.type === 'host_source_prefill');
    assert.equal(receipts.length, 1); assert.equal(receipts[0]!.detail.actor, 'host');
    assert.equal(receipts[0]!.detail.model_explicit_completion_required, true);
    await tools.invoke('submit_candidate_records', { ...tools.ids, records: [], batch_complete: true }, 'explicit-model-completion');
    assert.equal(tools.completed, true);
  } finally { store.close(); }
});

test('host prefill cannot disclose quarantined glyph lines, bibliography or a different assigned batch', async () => {
  const fixture = makeEvidenceFixture(['An unsafe source scale is 50 mm.', 'CT shows spiculation.', 'An independent separate statement.',
    'References', '1. Smith A. J Med. 2024;2:1-8.']);
  fixture.document.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 25, end: 26,
    font_name: 'Custom', font_program_sha256: 'a'.repeat(64), pdf_character_code: 109, precision: 'glyph_offset' }];
  const article = buildArticleScope(fixture.document), selection = selectSourceBlocks(fixture.document, article, 'B0');
  const batch = planExtractionBatches(fixture.document, { ...article, included_block_ids: selection.kept_block_ids }, { maxBlocks: 1, contextBlocks: 0 })[0]!;
  const store = new ExtractionStore(':memory:'); store.create(fixture.input, fixture.context.metadata); store.transition(fixture.input.run_id, 'extracting');
  const tools = new ExtractionTools({ ...fixture.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, batch, article, store, 'batch_lines');
  try {
    const prefill = await tools.prepareSourcePrefill();
    assert.match(prefill.content, /CT shows spiculation/); assert.doesNotMatch(prefill.content, /unsafe source scale|independent separate|Smith A\./);
    prefill.acknowledgeExposure();
    for (const index of [0, 2, 4]) await assert.rejects(tools.invoke('read_document_blocks', { ...tools.ids, block_ids: [fixture.document.blocks[index]!.block_id] }, 'denied-' + index), /block_not_authorized|bibliography_read_outside_task_scope/);
    assert.deepEqual([...tools.readBlocks], [fixture.document.blocks[1]!.block_id]);
    assert.equal(tools.completed, false);
  } finally { store.close(); }
});

async function run(prefill: boolean, steps: ResponsesStep[], requestLimit = 20) {
  const directory = await mkdtemp(resolve('runtime-data/source-prefill-test-')), store = new ExtractionStore(':memory:');
  const fixture = makeEvidenceFixture(['We observed spiculation on CT in lung cancer, measuring 9 mm.']);
  const server = await createRuntimeResponsesFixture(steps, { summaryAssessments: () => store.current(fixture.input.run_id).map(v => ({
    record_id: v.record.record_id, expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' })) });
  const budget = new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint, Date.now, {
    limits: { ...S4_LIMITS, requests: requestLimit }, authorization: { id: 'local-source-prefill', source: 'synthetic:no-paid-api', recorded_at: '2026-11-14T00:00:00Z' } });
  fixture.input.runtime_profile = { ...fixture.input.runtime_profile, provider: server.config.provider, model_id: server.config.modelId, endpoint: server.endpoint };
  try {
    const result = await runExtractionDocument({ input: fixture.input, document: fixture.document, metadata: fixture.context.metadata,
      catalog: fixture.catalog, config: server.config, profile: developmentProfile(server.config.modelId), budget, store,
      directory: resolve(directory, 'run'), strategy: 'baseline', prefillBatchSource: prefill });
    const delivery = JSON.parse(await readFile(resolve(directory, 'run/delivery.json'), 'utf8'));
    return { result, delivery, requests: server.requests, totals: budget.totals(), halted: budget.ledger.halted };
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
}

test('installed SDK batch prefill reduces three local requests to one while exact source and summary completion remain unchanged', async () => {
  const old = await run(false, [context, read, finish, summary]), fresh = await run(true, [finish, summary]);
  assert.equal(old.result.error, undefined); assert.equal(fresh.result.error, undefined);
  assert.equal(old.requests.length, 4); assert.equal(fresh.requests.length, 2);
  assert.equal(old.result.coverage.explicitly_completed_source_blocks, 1); assert.equal(fresh.result.coverage.explicitly_completed_source_blocks, 1);
  assert.equal(fresh.result.coverage.whole_document_summary_complete, true);
  assert.deepEqual(fresh.delivery.records.map((r: { original_fragments: unknown }) => r.original_fragments), old.delivery.records.map((r: { original_fragments: unknown }) => r.original_fragments));
  assert.equal(fresh.result.events.filter(e => e.type === 'host_source_prefill').length, 1);
  assert.equal(fresh.result.events.filter(e => e.type === 'model_tool_argument_shape' && e.detail.tool === 'read_document_blocks').length, 0);
  assert.match(JSON.stringify(fresh.requests[0]!.body), /We observed spiculation on CT in lung cancer, measuring 9 mm\./);
});

test('prefill does not infer explicit completion from a prose response or expand the request budget for summary', async () => {
  const noCompletion = await run(true, [{ text: 'Finished reading.' }, summary]);
  assert.equal(noCompletion.result.coverage.explicitly_completed_source_blocks, 0);
  assert.equal(noCompletion.result.task_processing_complete, false);
  const capped = await run(true, [finish, summary], 2);
  assert.equal(capped.requests.length, 2); assert.equal(capped.halted, 'experiment_request_limit');
  assert.equal(capped.result.state, 'partial'); assert.equal(capped.result.coverage.whole_document_summary_complete, false);
});

test('a failed HTTP response never creates a host source exposure receipt', async () => {
  const value = await run(true, [{ status: 400 }], 1);
  assert.equal(value.requests.length, 1); assert.equal(value.result.events.filter(e => e.type === 'host_source_prefill').length, 0);
  assert.equal(value.result.coverage.source_blocks_read, 0); assert.equal(value.result.coverage.explicitly_completed_source_blocks, 0);
});

test('the observed six-update summary shape is rejected, diagnosed and corrected within the existing three-update schema', async () => {
  const invalid: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} }, {
    name: 'submit_candidate_records', arguments: { summary: 'Synthetic overfull update array.', reviews: [], links: [],
      updates: Array.from({ length: 6 }, () => ({ ...statement })), summary_complete: true },
  }] };
  const value = await run(true, [finish, invalid, summary]);
  assert.equal(value.result.error, undefined); assert.equal(value.result.coverage.whole_document_summary_complete, true);
  const correction = value.result.events.find(e => e.type === 'protocol_correction')!;
  assert.equal(correction.detail.parameters_rewritten, false);
  const sample = correction.detail.failed_argument_samples[0];
  assert.equal(sample.array_lengths.updates, 6);
  assert.deepEqual(sample.schema_array_violations, [{ path: 'updates', actual_items: 6, max_items: 3 }]);
  assert.equal(value.result.versions.length, 2, 'rejected six-update array wrote no candidate versions');
  assert.equal(value.requests.length, 3, 'correction stays in the existing session and ledger');
});
