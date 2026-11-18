import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { LegacyCompletionProjection, type LegacyCompletionMetadata } from '../src/workflow-completion.js';
import type { WorkbenchRun } from '../../../packages/contracts/src/workbench.js';
import { makeEvidenceFixture } from '../../../tests/extraction/fixtures/evidence-fixtures.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const directory = await mkdtemp(resolve('runtime-data/item5-legacy-test-')), f = makeEvidenceFixture(['Reliable source.', 'Uncertain glyph.']);
  const pdf = Buffer.from('SYNTHETIC SOURCE IDENTITY ONLY; no parser or medical quality claim.');
  f.document.file_sha256 = sha(pdf); f.document.source.file_reference = resolve(directory, 'source.pdf');
  const ir = Buffer.from(JSON.stringify(f.document)), assigned = f.document.blocks[0]!.block_id, gap = f.document.blocks[1]!.block_id;
  const coverage = { task_processing_complete: false, task_processing_blockers: ['source_glyph_quarantine_unresolved'], legacy_run_state_is_not_task_scope_completion: true,
    parser_status: 'partial', selected_source_block_processing_complete: true, whole_document_summary_complete: true, dispatched_source_blocks: 1,
    explicitly_completed_source_blocks: 1, completed_source_block_ids: [assigned], source_glyph_quarantined_block_ids: [gap], task_scope_unprocessed_source_block_ids: [gap],
    failed_source_block_ids: [], task_scope_failed_source_block_ids: [], quarantined_source_block_ids: [] };
  const result = { schema_version: 's4-extraction-run-1', source_selection_condition: 'B0', run_id: f.input.run_id, document_id: f.document.document_id,
    state: 'partial', task_processing_complete: false, delivery_validation: { status: 'passed', rejected_delivery_written: false }, coverage,
    candidate_count: 0, records: [], summary_attempts: [{ status: 'completed' }], ledger_totals: { requests: 1 }, events: [
      { type: 'coverage_inventory', detail: { total_batches: 1, dispatched_blocks: 1 } },
      { type: 'batch', detail: { batch_id: 'one', status: 'completed', explicit_completion_received: true, assigned_block_ids: [assigned], result: {} } },
      { type: 'document_summary', detail: { complete: true, completion_blockers: [] } },
    ] };
  const delivery = { schema_version: 'verbatim-figure-delivery-1', document_id: f.document.document_id, file_sha256: f.document.file_sha256, text_version: f.document.text_version, records: [] };
  const ledger = { halted: null, requests: [{}] };
  const save = async () => Promise.all([writeFile(resolve(directory, 'source.pdf'), pdf), writeFile(resolve(directory, 'source-ir.json'), ir),
    writeFile(resolve(directory, 'result.json'), JSON.stringify(result)), writeFile(resolve(directory, 'delivery.json'), JSON.stringify(delivery)), writeFile(resolve(directory, 'request-ledger.json'), JSON.stringify(ledger))]);
  await save();
  const run: WorkbenchRun = { run_id: f.input.run_id, document_id: f.document.document_id, state: 'partial', fixture: true, candidate_count: 0,
    task_processing_complete: false, result_ready: true, finished_at: '2026-11-15T00:00:00Z' };
  const metadata: LegacyCompletionMetadata = { directory, pdf: { path: relative(process.cwd(), resolve(directory, 'source.pdf')), sha256: sha(pdf) },
    ir: { path: relative(process.cwd(), resolve(directory, 'source-ir.json')), sha256: sha(ir) }, document_id: run.document_id, file_sha256: f.document.file_sha256,
    text_version: f.document.text_version, blockers: coverage.task_processing_blockers, result_saved: true, unsafe_events: 0, event_seq: 3 };
  return { directory, result, delivery, ledger, coverage, metadata, run, save, close: () => rm(directory, { recursive: true, force: true }) };
}

test('verified legacy zero-candidate flow derives completion without changing its original false or writing artifacts', async () => {
  const f = await fixture(), audit = new LegacyCompletionProjection(process.cwd()); let reads = 0;
  try {
    const before = await readFile(resolve(f.directory, 'result.json'));
    const load = () => { reads++; return f.coverage; };
    const [first, overlapping] = await Promise.all([audit.project(f.run, f.metadata, load), audit.project(f.run, f.metadata, load)]);
    assert.equal(first?.processing_complete, true); assert.deepEqual(overlapping, first);
    assert.equal(first?.rule_origin, 'legacy_evidence_projection'); assert.equal(first?.original_task_processing_complete, false);
    assert.deepEqual(await audit.project(f.run, f.metadata, load), first); assert.equal(reads, 1, 'same-run flight and hot cache avoid full evidence decodes');
    assert.equal(f.coverage.task_processing_complete, false); assert.deepEqual(await readFile(resolve(f.directory, 'result.json')), before);
  } finally { await f.close(); }
});

test('changed or missing saved delivery/PDF evidence immediately invalidates the legacy projection cache', async () => {
  const f = await fixture(), audit = new LegacyCompletionProjection(process.cwd());
  try {
    assert.ok(await audit.project(f.run, f.metadata, () => f.coverage));
    f.delivery.document_id = 'another-paper'; await f.save();
    assert.equal(await audit.project(f.run, f.metadata, () => f.coverage), undefined);
    f.delivery.document_id = f.run.document_id; await f.save(); assert.ok(await audit.project(f.run, f.metadata, () => f.coverage));
    await writeFile(resolve(f.directory, 'source.pdf'), 'changed source');
    assert.equal(await audit.project(f.run, f.metadata, () => f.coverage), undefined);
    await f.save(); await rm(resolve(f.directory, 'delivery.json'));
    assert.equal(await audit.project(f.run, f.metadata, () => f.coverage), undefined);
  } finally { await f.close(); }
});

test('summary-only, budget failure, empty reliable input and source-binding mismatch cannot promote legacy completion', async () => {
  const f = await fixture(), audit = new LegacyCompletionProjection(process.cwd());
  try {
    for (const change of ['summary', 'budget', 'empty', 'binding']) {
      const original = structuredClone({ result: f.result, ledger: f.ledger });
      if (change === 'summary') f.result.events = f.result.events.filter(event => event.type !== 'batch');
      if (change === 'budget') f.ledger.halted = 'experiment_request_limit' as never;
      if (change === 'empty') f.result.coverage.dispatched_source_blocks = 0;
      if (change === 'binding') f.result.run_id = 'other-run';
      await f.save(); assert.equal(await audit.project(f.run, f.metadata, () => f.coverage), undefined, change);
      Object.assign(f.result, original.result); Object.assign(f.coverage, original.result.coverage); f.result.coverage = f.coverage; Object.assign(f.ledger, original.ledger);
    }
  } finally { await f.close(); }
});

test('cancelled, unsupported, finalizing, unknown or errored legacy runs preserve their original status', async () => {
  const f = await fixture(), audit = new LegacyCompletionProjection(process.cwd());
  try {
    for (const changed of [{ state: 'cancelled' }, { state: 'failed' }, { result_ready: false }, { finished_at: undefined },
      { task_processing_complete: undefined }, { error: 'document_time_limit' }]) {
      assert.equal(await audit.project({ ...f.run, ...changed }, f.metadata, () => f.coverage), undefined);
    }
    for (const changed of [{ result_saved: false }, { unsafe_events: 1 }, { blockers: ['source_glyph_quarantine_unresolved', 'summary_incomplete'] }]) {
      assert.equal(await audit.project(f.run, { ...f.metadata, ...changed }, () => f.coverage), undefined);
    }
  } finally { await f.close(); }
});
