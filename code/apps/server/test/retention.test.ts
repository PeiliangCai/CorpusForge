import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';

test('default retention, reversible exclusion and conflict guards persist independently of evidence and approvals', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/retention-test-')), database = resolve(directory, 'test.sqlite');
  let store = new ExtractionStore(database), legacy = new RunStore(), workflow = new WorkbenchWorkflow(store, { directory });
  let app = buildApp(legacy, undefined, workflow);
  try {
    await app.ready();
    const detail = await workflow.detail('L07'), output = detail.outputs[0]!, original = output.records[0]!, id = output.id;
    assert.ok(output.records.every(record => record.retention?.status === 'kept' && record.retention.origin === 'default'));
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM workbench_retentions').get()!.n, 0);
    const reviewsBefore = store.db.prepare('SELECT * FROM workbench_reviews').all(), versionsBefore = store.db.prepare('SELECT * FROM s4_versions').all();
    const path = `/api/workbench/runs/${encodeURIComponent(id)}/records/${original.id}/retention`;
    const excludedResponse = await app.inject({ method: 'POST', url: path, payload: { expected_version: original.version, expected_retention_revision: 0, status: 'excluded' } });
    assert.equal(excludedResponse.statusCode, 200); const excluded = excludedResponse.json().record;
    assert.equal(excluded.version, original.version); assert.equal(excluded.retention.status, 'excluded'); assert.equal(excluded.retention.revision, 1);
    assert.deepEqual(excluded.fragments, original.fragments); assert.equal(excluded.text_fingerprint, original.text_fingerprint); assert.equal(excluded.delivery_fingerprint, original.delivery_fingerprint);
    assert.equal(excluded.text_approved, false); assert.equal(excluded.evidence_role, original.evidence_role);
    assert.deepEqual(store.db.prepare('SELECT * FROM workbench_reviews').all(), reviewsBefore); assert.deepEqual(store.db.prepare('SELECT * FROM s4_versions').all(), versionsBefore);
    const stale = await app.inject({ method: 'POST', url: path, payload: { expected_version: original.version, expected_retention_revision: 0, status: 'kept' } });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().current_retention_revision, 1);
    const wrongVersion = await app.inject({ method: 'POST', url: path, payload: { expected_version: original.version - 1, expected_retention_revision: 1, status: 'kept' } });
    assert.equal(wrongVersion.statusCode, 409);
    const restored = (await app.inject({ method: 'POST', url: path, payload: { expected_version: original.version, expected_retention_revision: 1, status: 'kept' } })).json().record;
    assert.equal(restored.retention.revision, 2); assert.equal(restored.retention.status, 'kept');
    await workflow.retainRecord(id, original.id, { expected_version: original.version, expected_retention_revision: 2, status: 'excluded' });
    const revised = await workflow.revise(id, original.id, { expected_version: original.version, reviewer: 'isolated-engineering-test', labels: { comment: 'Separate source annotation.' } });
    assert.equal(revised.record.retention!.status, 'excluded'); assert.equal(revised.record.retention!.revision, 3);
    assert.ok(workflow.events(id).some(event => event.type === 'retention_changed'));
    await app.close(); legacy.close(); store.close();
    store = new ExtractionStore(database); legacy = new RunStore(); workflow = new WorkbenchWorkflow(store, { directory, sources: false }); app = buildApp(legacy, undefined, workflow); await app.ready();
    const persisted = (await workflow.runDetail(id)).output.records.find(record => record.id === original.id)!;
    assert.equal(persisted.retention!.status, 'excluded'); assert.equal(persisted.version, revised.record.version);
    await workflow.deletePaper('L07'); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM workbench_retentions WHERE run_id=?').get(id)!.n, 0);
  } finally { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('latest explicit legacy rejection is preserved across edits and can be reversed by pending, approval or keep', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/retention-legacy-test-')), store = new ExtractionStore(resolve(directory, 'test.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { directory });
  try {
    const output = (await workflow.detail('L07')).outputs[0]!, id = output.id, recordId = output.records[0]!.id;
    const review = async (action: 'reject' | 'pending' | 'approve_text') => {
      const record = (await workflow.runDetail(id)).output.records.find(record => record.id === recordId)!;
      return (await workflow.reviewRecord(id, recordId, { expected_version: record.version, action, reviewer: 'isolated-legacy-tester', source_text_checked: true, relevance_checked: true, context_checked: true })).record;
    };
    let record = await review('reject'); assert.equal(record.retention!.status, 'excluded'); assert.equal(record.retention!.origin, 'legacy_review');
    record = (await workflow.revise(id, recordId, { expected_version: record.version, reviewer: 'isolated-legacy-tester', labels: { tags: ['edit-does-not-restore'] } })).record;
    assert.equal(record.retention!.status, 'excluded');
    record = await review('pending'); assert.equal(record.retention!.status, 'kept');
    await review('reject'); record = await review('approve_text'); assert.equal(record.retention!.status, 'kept');
    record = await review('reject');
    record = (await workflow.retainRecord(id, recordId, { expected_version: record.version, expected_retention_revision: 0, status: 'kept' })).record;
    assert.equal(record.retention!.status, 'kept'); assert.equal(record.text_approved, false); assert.equal(record.review_status, 'rejected');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM workbench_retentions').get()!.n, 1);
    record = await review('reject'); assert.equal(record.retention!.status, 'excluded'); assert.equal(record.retention!.revision, 2);
    record = await review('pending'); assert.equal(record.retention!.status, 'kept'); assert.equal(record.retention!.revision, 3);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

function archiveEntries(bytes: Buffer) {
  const tar = gunzipSync(bytes), entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const rawName = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/s, ''); if (!rawName) break;
    const name = rawName.replace(/^\.\//u, '');
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('retained JSONL, CSV and package select unexcluded current records, preserve source bytes and keep medical confirmation empty', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/retention-export-test-')), store = new ExtractionStore(resolve(directory, 'test.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { directory });
  try {
    const output = (await workflow.detail('L07')).outputs[0]!, id = output.id, excluded = output.records[0]!;
    await workflow.retainRecord(id, excluded.id, { expected_version: excluded.version, expected_retention_revision: 0, status: 'excluded' });
    const jsonl = await workflow.export(id, 'retained_jsonl'), rows = jsonl.bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, output.records.length - 1); assert.ok(!rows.some(record => record.record_id === excluded.id));
    for (const record of rows) {
      const original = output.records.find(value => value.id === record.record_id)!;
      assert.equal(record.record_version, original.version); assert.deepEqual(record.original_fragments, original.fragments); assert.deepEqual(record.context_fragments, original.context);
      assert.equal(record.text_fingerprint, original.text_fingerprint); assert.equal(record.delivery_fingerprint, original.delivery_fingerprint);
      assert.equal(record.export_review_status, 'retained_unconfirmed'); assert.equal(record.human_confirmation, null); assert.equal(record.medical_quality_approved, false);
      assert.equal(record.retention_selection.status, 'kept'); assert.equal(record.primary_assessment?.effective_role ?? 'primary_candidate', original.evidence_role);
    }
    const csv = (await workflow.export(id, 'retained_csv')).bytes.toString(); assert.match(csv, /retention_status,medical_quality_approved/); assert.ok(!csv.includes(excluded.id));
    const entries = archiveEntries((await workflow.export(id, 'retained_package')).bytes), manifest = JSON.parse(entries.get('manifest.json')!.toString());
    assert.equal(manifest.mode, 'retained'); assert.equal(manifest.record_level_human_confirmation, false); assert.equal(manifest.medical_quality_approved, false);
    assert.equal(manifest.record_count, rows.length); assert.equal(manifest.excluded_record_count, 1); assert.equal(manifest.retention_snapshot, 'retention.json');
    const snapshot = JSON.parse(entries.get('retention.json')!.toString()); assert.equal(snapshot.records.length, output.records.length);
    assert.equal(snapshot.records.find((record: { record_id: string }) => record.record_id === excluded.id).status, 'excluded');
    assert.deepEqual(JSON.parse(entries.get('reviews.json')!.toString()), []);
    assert.equal(entries.get('source-record-versions.jsonl')!.toString().trim().split('\n').length, rows.length);
    const originalRead = workflow['readPinned'].bind(workflow), source = workflow['run'](id).source!;
    for (const path of [source.ir.path, workflow['paper']('L07').pdf.path]) {
      workflow['readPinned'] = async artifact => { if (artifact.path === path) throw new ContractError('source_sha_mismatch'); return originalRead(artifact); };
      for (const kind of ['retained_jsonl', 'retained_csv', 'retained_package'] as const) await assert.rejects(workflow.export(id, kind), /source_integrity_blocked/);
    }
    workflow['readPinned'] = originalRead;
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM workbench_reviews').get()!.n, 0);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unavailable Figure assets remain pending references while retained text can be exported without image approval', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/retention-figure-test-')), store = new ExtractionStore(resolve(directory, 'test.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { directory });
  try {
    const detail = await workflow.detail('L05'), output = detail.outputs.find(value => value.records.some(record => record.association === 'paired'))!, paired = output.records.find(record => record.association === 'paired')!;
    // Exclusions are written only to this isolated test DB, avoiding repeated unrelated view generation.
    for (const record of output.records.filter(record => record.id !== paired.id)) store.db.prepare('INSERT INTO workbench_retentions VALUES(?,?,?)').run(output.id, record.id,
      JSON.stringify({ status: 'excluded', revision: 1, origin: 'user', record_version: record.version }));
    const before = JSON.parse((await workflow.export(output.id, 'retained_jsonl')).bytes.toString().trim());
    assert.equal(before.figure_association.status, 'paired'); assert.equal(before.human_confirmation, null); assert.equal(before.export_review_status, 'retained_unconfirmed');
    const run = await workflow.runDetail(output.id), sha = run.figures.find(figure => paired.figure_ids.includes(figure.id))!.assets[0]!.sha256;
    const originalRead = workflow['readPinned'].bind(workflow);
    workflow['readPinned'] = async artifact => { if (artifact.sha256 === sha) throw new ContractError('source_file_missing'); return originalRead(artifact); };
    const after = JSON.parse((await workflow.export(output.id, 'retained_jsonl')).bytes.toString().trim());
    assert.equal(after.figure_association.status, 'pending'); assert.deepEqual(after.figure_association.figure_ids, []); assert.deepEqual(after.original_fragments, before.original_fragments);
    assert.equal(after.human_confirmation, null); assert.equal(after.medical_quality_approved, false);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
