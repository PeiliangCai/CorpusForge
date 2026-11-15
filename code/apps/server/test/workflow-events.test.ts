import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, validateEvidenceSubmission } from '@t1/agent';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { makeEvidenceFixture } from '../../../tests/extraction/fixtures/evidence-fixtures.js';

test('event cursors preserve exact ordering and task isolation without decoding paper snapshots', async () => {
  const directory = await mkdtemp(resolve('runtime-data/events-cursor-test-')), store = new ExtractionStore(':memory:');
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false });
  try {
    for (const id of ['one', 'two']) {
      const f = makeEvidenceFixture(undefined, { runId: id, documentId: 'paper-' + id }); store.create(f.input, f.context.metadata);
      store.db.prepare('INSERT INTO workbench_papers VALUES(?,?)').run(f.input.document_id, '{}');
      // Event delivery depends on run existence, not on loading a potentially large source snapshot.
      store.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?)').run(id, f.input.document_id, '{"large_snapshot":"' + 'x'.repeat(1_000_000) + '"}');
      store.event(id, 'progress_receipt', { index: 1, actor: 'host' }); store.event(id, 'progress_receipt', { index: 2, actor: 'host' });
    }
    const all = store.events('one');
    for (const cursor of [0, 1, 2, 3, 100]) assert.deepEqual(workflow.events('one', cursor), all.filter(e => e.seq > cursor));
    assert.ok(workflow.events('one').every(e => e.run_id === 'one'));
    assert.throws(() => workflow.events('missing', 100), /workbench_run_not_found/);
    // The event query stays independent of the run payload's source/metadata serialization.
    store.db.prepare('UPDATE workbench_runs SET payload_json=? WHERE id=?').run('not-json-for-this-isolated-query-guard', 'one');
    assert.deepEqual(workflow.events('one', 2), all.filter(e => e.seq > 2));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('run-list progress projects real persisted receipts, caches safely and preserves partial terminal coverage', async () => {
  const directory = await mkdtemp(resolve('runtime-data/progress-query-test-')), store = new ExtractionStore(':memory:');
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false });
  try {
    await workflow.initialize();
    const f = makeEvidenceFixture(), id = f.input.run_id; store.create(f.input, f.context.metadata);
    store.db.prepare('INSERT INTO workbench_papers VALUES(?,?)').run(f.input.document_id, '{}');
    const row = { id, paper_id: f.input.document_id, created_at: new Date().toISOString(), origin: 'controlled_fixture', controlled: true, directory };
    store.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?)').run(id, f.input.document_id, JSON.stringify(row));
    store.transition(id, 'parsing'); store.event(id, 'source_parse_started', { actor: 'host' });
    store.event(id, 'figure_discovery_started', { actor: 'host' });
    assert.equal((await workflow.runs(id))[0]!.progress!.activity, 'figure_discovery');
    store.transition(id, 'extracting');
    store.event(id, 'coverage_inventory', { dispatched_blocks: 3, total_batches: 2, source_gap_blocks: 1 });
    store.batch(id, 'a', { status: 'completed', explicit_completion_received: true, assigned_block_ids: ['x', 'y'] });
    const record = validateEvidenceSubmission(f.submission, f.context).record!;
    const version = (recordId: string, n: number, status: 'active' | 'proposed') => store.db.prepare('INSERT INTO s4_versions VALUES(?,?,?,?)')
      .run(id, recordId, n, JSON.stringify({ record: { ...record, record_id: recordId }, version: n, actor: 'automatic', status }));
    version('active-record', 1, 'active'); version('active-record', 2, 'proposed'); version('proposal-only', 1, 'proposed'); version('deleted-record', 1, 'active');
    store.db.prepare('INSERT INTO workbench_annotations VALUES(?,?,?,?)').run(id, 'deleted-record', 1, JSON.stringify({ deleted: true }));
    const p = (await workflow.runs(id))[0]!.progress!;
    assert.equal(p.completed, 2); assert.equal(p.total, 3); assert.equal(p.completed_batches, 1); assert.equal(p.source_gap_blocks, 1);
    assert.equal(p.candidate_records, 1, 'only current active, visible evidence counts; proposed versions and deleted records do not');
    assert.equal((await workflow.runs(id))[0]!.progress!.completed, 2, 'a cached event projection returns the same observed count');
    store.transition(id, 'reconciling'); store.event(id, 'document_summary', { complete: false }); store.transition(id, 'partial');
    const final = (await workflow.runs(id))[0]!;
    assert.equal(final.state, 'partial'); assert.equal(final.progress!.stage, 'partial'); assert.equal(final.progress!.completed, 2);
    assert.equal(final.progress!.summary_completed, false); assert.equal(final.progress!.total, 3);
    assert.equal(final.progress!.activity, undefined);
    store.db.prepare('UPDATE workbench_runs SET payload_json=? WHERE id=?').run(JSON.stringify({ ...row, created_at: undefined, origin: 'historical_compatibility_replay' }), id);
    const historical = (await workflow.runs(id))[0]!.progress!;
    assert.equal(historical.elapsed_ms, undefined); assert.equal(historical.execution_elapsed_ms, undefined);
    assert.equal(historical.stage, 'partial'); assert.equal(historical.candidate_records, 1);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
