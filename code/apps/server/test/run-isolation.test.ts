import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runIsolationFixture } from './run-isolation-fixture.js';

test('same-content runs keep records, versions, assets, events, retention and exports bound to the exact run', async () => {
  const f = await runIsolationFixture();
  try {
    const { older, newer, empty } = f.ids as { older: string; newer: string; empty: string };
    const get = async (id: string) => {
      const response = await f.app.inject(`/api/workbench/runs/${id}`); assert.equal(response.statusCode, 200); return response.json();
    };
    const a = await get(older), b = await get(newer), c = await get(empty);
    assert.deepEqual([a.output.records.length, b.output.records.length, c.output.records.length], [1, 2, 0]);
    assert.equal(a.paper.id, b.paper.id); assert.equal(b.paper.id, c.paper.id);
    assert.notDeepEqual(a.output.records[0].fragments, b.output.records[0].fragments);
    for (const [id, detail] of [[older, a], [newer, b], [empty, c]] as const) {
      assert.equal(detail.run.run_id, id); assert.equal(detail.output.id, id);
      assert.ok(detail.output.records.every((record: { run_id: string }) => record.run_id === id));
      assert.ok(detail.figures.flatMap((figure: { assets: Array<{ url: string }> }) => figure.assets).every((asset: { url: string }) => asset.url.includes(`/runs/${id}/figures/`)));
      assert.ok(f.workflow.events(id).every(event => event.run_id === id));
      assert.ok(f.store.versions(id).every(version => version.record.extraction_trace.run_id === id));
    }
    const shared = a.output.records[0], sharedInB = b.output.records.find((record: { id: string }) => record.id === shared.id)!;
    assert.ok(sharedInB);
    await f.workflow.retainRecord(older, shared.id, { expected_version: shared.version, expected_retention_revision: 0, status: 'excluded' });
    assert.equal((await get(older)).output.records[0].retention.status, 'excluded');
    assert.equal((await get(newer)).output.records.find((record: { id: string }) => record.id === shared.id).retention.status, 'kept');
    const before = createHash('sha256').update(JSON.stringify(f.store.versions(older))).digest('hex');
    await f.workflow.revise(newer, shared.id, { expected_version: sharedInB.version, reviewer: 'isolated-engineering-test', labels: { comment: 'Only this task.' } });
    assert.equal(createHash('sha256').update(JSON.stringify(f.store.versions(older))).digest('hex'), before);
    const csv = (await f.workflow.export(newer, 'retained_csv')).bytes.toString();
    const exported = (await f.workflow.export(newer, 'retained_jsonl')).bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(exported.length, 2); assert.ok(exported.every(record => record.run_id === newer));
    assert.ok(!csv.includes(older));
    assert.deepEqual(exported.map(record => record.original_fragments), (await get(newer)).output.records.map((record: { fragments: unknown }) => record.fragments));
    const paper = await f.workflow.detail(f.paper.id);
    assert.equal(paper.outputs.length, 3);
    assert.deepEqual(paper.outputs.map(output => [output.id, output.records.length]).sort(), [[older, 1], [newer, 2], [empty, 0]].sort());
    const mismatch = structuredClone(f.store.current(older)[0]!.record);
    f.store.db.prepare("UPDATE s4_runs SET state='extracting' WHERE id=?").run(newer);
    assert.throws(() => f.store.apply(newer, { action: 'insert', record: mismatch, expected_version: null, target_record_id: null, related_record_ids: [], issues: [],
      changes: [{ kind: 'insert', record_id: mismatch.record_id, expected_version: null, record: mismatch }] }), /s4_cross_run_evidence/);
    console.log(JSON.stringify({ same_pdf: true, candidate_counts: [1, 2, 0], isolated_record_id_collision: true,
      api_store_assets_events_retention_export_separate: true, production_business_writes: 0, paid_calls: 0 }));
  } finally { await f.close(); }
});
