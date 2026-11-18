import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExtractionStore, RunStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';

const replay = await controlledFixture({ delayMs: 1 });
const pdfs = await Promise.all(['L01', 'L05'].map(name => readFile(`evaluation/corpus/development-candidates/${name}.pdf`)));
async function setup(options = replay) {
  const directory = await mkdtemp(resolve('runtime-data/batch-task-test-')), store = new ExtractionStore(resolve(directory, 'fixture.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { ...options, directory, sources: false });
  const legacy = new RunStore(':memory:'), app = buildApp(legacy, undefined, workflow);
  const papers = await Promise.all(pdfs.map((bytes, i) => workflow.upload(bytes, `paper-${i + 1}.pdf`).then(value => value.paper)));
  const batchId = randomUUID(), scope = workflow.scopeCatalog().default_scope;
  const start = (index: number, requestId?: string, batch = batchId) => workflow.start(papers[index]!.id, scope, requestId, { kind: 'batch', batch_id: batch }, undefined, 'Whole task', `paper-${index + 1}.pdf`);
  return { directory, store, workflow, legacy, app, papers, batchId, scope, start, close: async () => { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('run list exposes persisted completion true/false/absent; summary completion does not supply it', async () => {
  const x = await setup();
  try {
    const ids: string[] = [];
    for (const completion of [true, false, undefined]) {
      const id = (await x.workflow.start(x.papers[0]!.id, x.scope)).run.run_id; await x.workflow.waitForIdle(); ids.push(id);
      const row = x.workflow['run'](id); row.coverage = { ...(completion === undefined ? {} : { task_processing_complete: completion }), whole_document_summary_complete: true };
      x.store.db.prepare('UPDATE workbench_runs SET payload_json=? WHERE id=?').run(JSON.stringify(row), id);
    }
    const listed = await x.workflow.runs();
    assert.deepEqual(ids.map(id => listed.find(run => run.run_id === id)!.task_processing_complete), [true, false, undefined]);
    assert.ok(ids.every(id => listed.find(run => run.run_id === id)!.progress?.summary_completed));
    assert.equal(Object.hasOwn(listed.find(run => run.run_id === ids[2])!, 'task_processing_complete'), false);
  } finally { await x.close(); }
});

test('whole batch deletion is atomic, idempotent and preserves same-paper single/other batch and shared PDFs', { timeout: 60_000 }, async () => {
  const x = await setup();
  try {
    const a = (await x.start(0, 'batch-member-first')).run, b = (await x.start(1, 'batch-member-second')).run; await x.workflow.waitForIdle();
    const sibling = (await x.workflow.start(x.papers[0]!.id, x.scope, 'separate-single', { kind: 'single' })).run;
    const other = (await x.start(1, 'other-batch-member', randomUUID())).run; await x.workflow.waitForIdle();
    const siblingBefore = (await x.workflow.runDetail(sibling.run_id)).output, otherBefore = (await x.workflow.runDetail(other.run_id)).output;
    const oldClient = await x.app.inject({ method: 'DELETE', url: '/api/workbench/runs/' + a.run_id });
    assert.equal(oldClient.statusCode, 409); assert.equal(oldClient.json().error, 'batch_task_deletion_required');
    assert.equal((await x.workflow.runs()).length, 4);
    const deleted = await x.app.inject({ method: 'DELETE', url: '/api/workbench/batches/' + x.batchId });
    assert.equal(deleted.statusCode, 200); assert.deepEqual(new Set(deleted.json().run_ids), new Set([a.run_id, b.run_id]));
    assert.deepEqual(new Set((await x.workflow.runs()).map(run => run.run_id)), new Set([sibling.run_id, other.run_id]));
    for (const id of [a.run_id, b.run_id]) for (const table of ['workbench_annotations', 'workbench_reviews', 'workbench_retentions', 'workbench_exports', 's4_batches', 's4_versions', 's4_events']) assert.equal(x.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`).get(id)!.n, 0, table);
    assert.deepEqual((await x.workflow.runDetail(sibling.run_id)).output, siblingBefore); assert.deepEqual((await x.workflow.runDetail(other.run_id)).output, otherBefore);
    for (let i = 0; i < 2; i++) assert.deepEqual(await x.workflow.pdf(x.papers[i]!.id), pdfs[i]);
    assert.equal((await x.workflow.deleteBatch(x.batchId)).already_deleted, true);
    await assert.rejects(x.start(0, 'batch-member-first'), /submission_result_deleted/);
    await assert.rejects(x.start(0, 'late-different-request'), /submission_result_deleted/);
  } finally { await x.close(); }
});

test('one active member blocks the entire deletion; batch cancel affects every active member', { timeout: 60_000 }, async () => {
  let pause = false, entered!: () => void, release!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const options = { ...replay, runner: { ...replay.runner!, execute: async (context: Parameters<NonNullable<typeof replay.runner>['execute']>[0]) => {
    if (pause) { entered(); await Promise.race([wait, new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))]); }
    return replay.runner!.execute(context);
  } } };
  const x = await setup(options);
  try {
    const first = (await x.start(0)).run; await x.workflow.waitForIdle(); pause = true;
    const second = (await x.start(1)).run; await seen;
    await assert.rejects(x.workflow.deleteBatch(x.batchId), /paper_busy_before_deleting_run/);
    assert.equal((await x.workflow.runs()).length, 2); assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM workbench_deleted_batches').get()!.n, 0);
    const response = await x.app.inject({ method: 'POST', url: '/api/workbench/batches/' + x.batchId + '/cancel', payload: {} });
    assert.equal(response.statusCode, 200); assert.equal(response.json().runs.find((run: { run_id: string }) => run.run_id === second.run_id).state, 'cancelled');
    assert.equal(response.json().runs.find((run: { run_id: string }) => run.run_id === first.run_id).state, 'completed');
    release(); await x.workflow.waitForIdle(); await x.workflow.deleteBatch(x.batchId); assert.equal((await x.workflow.runs()).length, 0);
  } finally { release(); await x.close(); }
});

test('ended batch deletes while a same-paper sibling parses; artifact cleanup waits for its source publication', { timeout: 60_000 }, async () => {
  let pause = false, entered!: () => void, release!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const x = await setup({ ...replay, parse: async (...args: Parameters<NonNullable<typeof replay.parse>>) => {
    if (pause) { entered(); await wait; }
    return replay.parse!(...args);
  } });
  try {
    const a = (await x.start(0)).run, b = (await x.start(1)).run; await x.workflow.waitForIdle();
    const target = x.workflow['run'](a.run_id), privatePath = resolve(target.directory, 'private-result.json');
    await writeFile(privatePath, '{"target_only":true}');
    pause = true;
    const sibling = (await x.workflow.start(x.papers[0]!.id, x.scope, 'independent-active-sibling', { kind: 'single' })).run; await seen;
    const deletion = await x.app.inject({ method: 'DELETE', url: '/api/workbench/batches/' + x.batchId });
    assert.equal(deletion.statusCode, 200, deletion.body); assert.equal(deletion.json().cleanup_deferred, true);
    assert.deepEqual(new Set(deletion.json().run_ids), new Set([a.run_id, b.run_id]));
    assert.deepEqual((await x.workflow.runs()).map(run => run.run_id), [sibling.run_id]);
    assert.equal((await x.workflow.runs())[0]!.state, 'parsing');
    await access(privatePath); await access(resolve(x.workflow.codeRoot, target.source!.ir.path));
    assert.deepEqual(await x.workflow.pdf(x.papers[0]!.id), pdfs[0]);
    const retry = await x.workflow.deleteBatch(x.batchId); assert.equal(retry.already_deleted, true); assert.equal(retry.cleanup_deferred, true);
    release();
    // Observe automatic cleanup after coordinator release, without using
    // waitForIdle() as an extra cleanup trigger.
    for (let attempt = 0; attempt < 500 && JSON.parse(x.store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(a.run_id)!.payload_json as string).status !== 'complete'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const current = await x.workflow.runDetail(sibling.run_id); assert.equal(current.run.state, 'completed'); assert.equal(current.source_status, 'valid');
    await assert.rejects(access(privatePath), /ENOENT/);
    for (const id of [a.run_id, b.run_id]) assert.equal(JSON.parse(x.store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(id)!.payload_json as string).status, 'complete');
    assert.ok(!x.workflow.events(sibling.run_id).some(event => event.type === 'workflow_error'));
  } finally { release(); await x.close(); }
});

test('batch export manifest includes every member, uses actual package counts and excludes other submissions', { timeout: 60_000 }, async () => {
  const x = await setup();
  try {
    const a = (await x.start(0)).run, b = (await x.start(1)).run; await x.workflow.waitForIdle();
    const sibling = (await x.workflow.start(x.papers[0]!.id, x.scope, undefined, { kind: 'single' })).run; await x.workflow.waitForIdle();
    const empty = await x.workflow.runDetail(b.run_id);
    for (const record of empty.output.records) await x.workflow.retainRecord(b.run_id, record.id, { expected_version: record.version, expected_retention_revision: record.retention?.revision ?? 0, status: 'excluded' });
    const exported = await x.workflow.exportBatch(x.batchId), archive = resolve(x.directory, 'whole.tar.gz'), unpack = resolve(x.directory, 'unpacked');
    await writeFile(archive, exported.bytes); await fs.mkdir(unpack); execFileSync('tar', ['-xzf', archive, '-C', unpack]);
    const manifest = JSON.parse(await readFile(resolve(unpack, 'manifest.json'), 'utf8'));
    assert.deepEqual(new Set(manifest.members.map((member: { run_id: string }) => member.run_id)), new Set([a.run_id, b.run_id]));
    assert.ok(!JSON.stringify(manifest).includes(sibling.run_id));
    const zero = manifest.members.find((member: { run_id: string }) => member.run_id === b.run_id); assert.equal(zero.kept_count, 0); assert.equal(zero.package, null);
    const member = manifest.members.find((member: { run_id: string }) => member.run_id === a.run_id), child = resolve(x.directory, 'child'); await fs.mkdir(child);
    execFileSync('tar', ['-xzf', resolve(unpack, member.package), '-C', child]);
    const delivery = JSON.parse(await readFile(resolve(child, 'delivery.json'), 'utf8')), records = [...delivery.records, ...(delivery.background_records ?? [])];
    assert.equal(member.kept_count, records.length); assert.ok(records.every(record => record.run_id === a.run_id && record.document_id === a.document_id));
    const source = x.workflow['run'](a.run_id).source!, sourcePath = resolve(x.workflow.codeRoot, source.ir.path); assert.ok(sourcePath.startsWith(x.directory + '/')); await rm(sourcePath);
    await assert.rejects(x.workflow.exportBatch(x.batchId), error => String(error).includes('batch_export_member_blocked:' + a.run_id));
  } finally { await x.close(); }
});

test('a file cleanup failure leaves all members deleted and durable whole-task retry completes cleanup', { timeout: 60_000 }, async () => {
  const x = await setup(); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const a = (await x.start(0)).run, b = (await x.start(1)).run; await x.workflow.waitForIdle();
    const path = resolve(x.workflow['run'](a.run_id).directory, 'private-results.json'); await writeFile(path, '{}');
    const original = fs.rm; interceptor = mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => { if (String(args[0]) === path) throw new Error('fixture_cleanup_error'); return original(...args); }); syncBuiltinESMExports();
    const deleted = await x.app.inject({ method: 'DELETE', url: '/api/workbench/batches/' + x.batchId });
    assert.equal(deleted.statusCode, 503); assert.equal(deleted.json().error, 'batch_deleted_cleanup_pending'); assert.deepEqual(new Set(deleted.json().run_ids), new Set([a.run_id, b.run_id]));
    assert.equal((await x.workflow.runs()).length, 0); await access(path);
    interceptor.mock.restore(); interceptor = undefined; syncBuiltinESMExports();
    const retried = await x.workflow.deleteBatch(x.batchId); assert.equal(retried.already_deleted, true);
    if (retried.cleanup_deferred) await x.workflow.waitForIdle();
    await assert.rejects(access(path), /ENOENT/);
    assert.equal(x.store.db.prepare("SELECT COUNT(*) n FROM workbench_deleted_runs WHERE json_extract(payload_json,'$.status')='complete'").get()!.n, 2);
  } finally { interceptor?.mock.restore(); syncBuiltinESMExports(); await x.close(); }
});
