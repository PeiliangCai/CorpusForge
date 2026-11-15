import test from 'node:test';
import assert from 'node:assert/strict';
import { backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow, MAX_PDF_BYTES, type WorkflowOptions } from '../src/workflow.js';
import { buildApp } from '../src/app.js';

const PDF = Buffer.from('%PDF-1.4\n% SUBMISSION ENGINEERING STUB\n%%EOF\n');
async function until(condition: () => boolean) { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(10); } throw new Error('submission_fixture_timeout'); }
function gate() {
  const started: string[] = [], releases = new Map<string, () => void>(); let prepares = 0;
  const options: WorkflowOptions = { sources: false,
    runner: { controlled: true, provider: 'submission-fixture', model_id: 'no-model', prepare: async () => { prepares++; await delay(20); }, execute: async () => { throw new Error('no model is allowed in the gate'); } },
    parse: async (input, _path, _directory, signal) => new Promise((_resolve, reject) => {
      started.push(input.run_id); const finish = () => { releases.delete(input.run_id); reject(new ContractError('submission_gate_ended')); };
      releases.set(input.run_id, finish); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
    }) };
  return { options, started, releases, prepares: () => prepares };
}

test('same upload request survives concurrent callers and response loss; mismatched payloads and deleted results cannot recreate a paper', async () => {
  const directory = await mkdtemp(resolve('runtime-data/submission-upload-')), store = new ExtractionStore(resolve(directory, 'db.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false });
  try {
    const saved = await Promise.all(Array.from({ length: 5 }, () => workflow.upload(PDF, 'first.pdf', 'first', 'upload-request-0001')));
    assert.equal(new Set(saved.map(item => item.paper.id)).size, 1); assert.equal((await workflow.papers()).length, 1);
    assert.equal((await workflow.upload(PDF, 'first.pdf', 'first', 'upload-request-0001')).paper.id, saved[0]!.paper.id);
    await assert.rejects(workflow.upload(PDF, 'changed.pdf', 'first', 'upload-request-0001'), /submission_payload_conflict/);
    await workflow.deletePaper(saved[0]!.paper.id);
    await assert.rejects(workflow.upload(PDF, 'first.pdf', 'first', 'upload-request-0001'), /submission_result_deleted/);
    assert.equal((await workflow.papers()).length, 0);
    // Existing clients without keys keep their original independent-paper behavior.
    assert.notEqual((await workflow.upload(PDF, 'same.pdf')).paper.id, (await workflow.upload(PDF, 'same.pdf')).paper.id);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('one start key creates one durable run and one prepare; replay after restart returns the interrupted run without scheduling or widening scope', async () => {
  const directory = await mkdtemp(resolve('runtime-data/submission-start-')), database = resolve(directory, 'db.sqlite'), store = new ExtractionStore(database), fixture = gate();
  const workflow = new WorkbenchWorkflow(store, { ...fixture.options, directory });
  let restarted: WorkbenchWorkflow | undefined, restored: ExtractionStore | undefined;
  try {
    const paper = (await workflow.upload(PDF, 'start.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const saved = await Promise.all(Array.from({ length: 5 }, () => workflow.start(paper.id, scope, 'start-request-0001')));
    const id = saved[0]!.run.run_id; assert.equal(new Set(saved.map(item => item.run.run_id)).size, 1); assert.equal(fixture.prepares(), 1);
    assert.equal(saved[0]!.run.submission, undefined);
    const canonical = JSON.stringify({ paper_id: paper.id, scope }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    assert.equal(store.db.prepare('SELECT payload_sha256 FROM workbench_requests WHERE request_id=?').get('start-request-0001')!.payload_sha256,
      createHash('sha256').update(canonical).digest('hex'), 'metadata-free requests retain the exact pre-upgrade hash');
    await until(() => fixture.started.length === 1); assert.equal((await workflow.runs()).length, 1);
    await assert.rejects(workflow.start(paper.id, { ...scope, cancers: { mode: 'selected', ids: [] } }, 'start-request-0001'), /submission_payload_conflict/);
    assert.equal((await workflow.start(paper.id, scope, 'start-request-0001')).run.run_id, id); assert.equal(fixture.prepares(), 1);
    await backup(store.db, resolve(directory, 'restart.sqlite'));
    restored = new ExtractionStore(resolve(directory, 'restart.sqlite')); const after = gate();
    restarted = new WorkbenchWorkflow(restored, { ...after.options, directory }); await restarted.initialize();
    const replay = await restarted.start(paper.id, scope, 'start-request-0001');
    assert.equal(replay.run.run_id, id); assert.equal(replay.run.state, 'interrupted'); assert.deepEqual(replay.run.scope, scope);
    assert.equal(replay.run.submission, undefined); assert.equal((await restarted.runDetail(id)).run.submission, undefined);
    assert.equal(after.prepares(), 0); assert.deepEqual(after.started, []);
  } finally { await workflow.close(); store.close(); await restarted?.close(); restored?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('submission kind and batch identity persist in list/detail/restart and are bound to each start key without rescheduling', async () => {
  const directory = await mkdtemp(resolve('runtime-data/submission-kind-')), store = new ExtractionStore(resolve(directory, 'db.sqlite')), fixture = gate();
  const workflow = new WorkbenchWorkflow(store, { ...fixture.options, directory });
  let restarted: WorkbenchWorkflow | undefined, restored: ExtractionStore | undefined;
  try {
    const paper = (await workflow.upload(PDF, 'kind.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const submission = { kind: 'batch', batch_id: randomUUID() } as const;
    const accepted = await Promise.all(Array.from({ length: 4 }, () => workflow.start(paper.id, scope, 'batch-kind-0001', submission)));
    const id = accepted[0]!.run.run_id; assert.equal(new Set(accepted.map(value => value.run.run_id)).size, 1); assert.equal(fixture.prepares(), 1);
    assert.deepEqual(accepted[0]!.run.submission, submission);
    await assert.rejects(workflow.start(paper.id, scope, 'batch-kind-0001', { kind: 'single' }), /submission_payload_conflict/);
    await assert.rejects(workflow.start(paper.id, scope, 'batch-kind-0001', { ...submission, batch_id: randomUUID() }), /submission_payload_conflict/);
    await assert.rejects(workflow.start(paper.id, scope, 'batch-kind-0001'), /submission_payload_conflict/);
    assert.equal(fixture.prepares(), 1);
    const single = (await workflow.start(paper.id, scope, 'single-kind-0001', { kind: 'single' })).run;
    assert.deepEqual(single.submission, { kind: 'single' });
    for (const value of [await workflow.runDetail(id), { run: (await workflow.runs(id))[0]! }]) assert.deepEqual(value.run.submission, submission);
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(id)!.payload_json as string).submission, submission);
    await backup(store.db, resolve(directory, 'restart.sqlite')); restored = new ExtractionStore(resolve(directory, 'restart.sqlite'));
    const after = gate(); restarted = new WorkbenchWorkflow(restored, { ...after.options, directory }); await restarted.initialize();
    const replay = (await restarted.start(paper.id, scope, 'batch-kind-0001', submission)).run;
    assert.equal(replay.run_id, id); assert.deepEqual(replay.submission, submission); assert.equal(replay.state, 'interrupted');
    assert.deepEqual((await restarted.runDetail(id)).run.submission, submission);
    assert.deepEqual((await restarted.runs(single.run_id))[0]!.submission, { kind: 'single' });
    assert.equal(after.prepares(), 0); assert.deepEqual(after.started, []);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'workbench_%'").get()!.n, 8, 'no batch table is added');
  } finally { await workflow.close(); store.close(); await restarted?.close(); restored?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP permits only strict optional submission metadata and keeps scope and server configuration validation', async () => {
  const directory = await mkdtemp(resolve('runtime-data/submission-metadata-http-')), store = new ExtractionStore(resolve(directory, 'db.sqlite')), legacy = new RunStore(resolve(directory, 'legacy.sqlite'));
  const fixture = gate(), workflow = new WorkbenchWorkflow(store, { ...fixture.options, directory }), app = buildApp(legacy, undefined, workflow);
  try {
    await app.ready(); const paper = (await workflow.upload(PDF, 'metadata.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const post = (payload: unknown, key = 'metadata-http-0001') => app.inject({ method: 'POST', url: `/api/workbench/papers/${paper.id}/runs`, headers: { 'x-t1-request-id': key }, payload: payload as any });
    for (const submission of [null, [], 'batch', {}, { kind: 'other' }, { kind: 'single', batch_id: randomUUID() }, { kind: 'batch' },
      { kind: 'batch', batch_id: 'x'.repeat(500) }, { kind: 'batch', batch_id: '../some/path' }, { kind: 'single', provider: 'injected' },
      { kind: 'batch', batch_id: randomUUID(), model_id: 'injected' }]) {
      const response = await post({ scope, submission }); assert.equal(response.statusCode, 400, JSON.stringify(submission)); assert.equal(response.json().error, 'invalid_submission_metadata');
    }
    for (const payload of [{ scope, provider: 'injected' }, { scope, submission: { kind: 'single' }, max_concurrent_runs: 999 }, { scope, model: {} }]) {
      const response = await post(payload); assert.equal(response.statusCode, 400); assert.equal(response.json().error, 'immutable_server_run_configuration');
    }
    assert.equal((await post({ scope: { ...scope, cancers: { mode: 'selected', ids: [] } }, submission: { kind: 'single' } })).statusCode, 400);
    assert.equal((await workflow.runs()).length, 0); assert.equal(fixture.prepares(), 0);
    const accepted = await post({ scope, submission: { kind: 'single' } }); assert.equal(accepted.statusCode, 202); assert.deepEqual(accepted.json().run.submission, { kind: 'single' });
    assert.equal((await post({ scope, submission: { kind: 'batch', batch_id: randomUUID() } })).statusCode, 409);
    const legacyRun = await post({ scope }, 'metadata-legacy-0001'); assert.equal(legacyRun.statusCode, 202); assert.equal(legacyRun.json().run.submission, undefined);
    assert.equal((await post({ scope }, 'metadata-legacy-0001')).json().run.run_id, legacyRun.json().run.run_id);
    assert.equal((await post({ scope, submission: { kind: 'single' } }, 'metadata-legacy-0001')).statusCode, 409);
    assert.equal((await workflow.runs()).length, 2);
  } finally { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a multi-paper batch keeps independent outcomes and the existing two-slot FIFO; invalid ranges never broaden', async () => {
  const directory = await mkdtemp(resolve('runtime-data/submission-batch-')), store = new ExtractionStore(resolve(directory, 'db.sqlite')), fixture = gate();
  const workflow = new WorkbenchWorkflow(store, { ...fixture.options, directory });
  try {
    const scope = workflow.scopeCatalog().default_scope, ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const paper = (await workflow.upload(PDF, `batch-${i}.pdf`, undefined, `upload-batch-${i}`)).paper;
      if (i === 1) await assert.rejects(workflow.start(paper.id, { ...scope, cancers: { mode: 'selected', ids: [] } }, `start-batch-${i}`), /cancers_selected_empty/);
      ids.push((await workflow.start(paper.id, scope, `start-batch-${i}`)).run.run_id);
    }
    await until(() => fixture.started.length === 2); assert.deepEqual(fixture.started, ids.slice(0, 2));
    assert.equal(store.snapshot(ids[2]!).state, 'queued'); assert.equal(store.snapshot(ids[3]!).state, 'queued');
    fixture.releases.get(ids[0]!)!(); await until(() => fixture.started.length === 3);
    assert.deepEqual(fixture.started, ids.slice(0, 3)); assert.equal(store.snapshot(ids[0]!).state, 'failed'); assert.equal(store.snapshot(ids[1]!).state, 'parsing');
    await workflow.cancel(ids[1]!); await until(() => fixture.started.length === 4);
    assert.deepEqual(fixture.started, ids); assert.equal(new Set((await workflow.runs()).map(run => run.document_id)).size, 4);
    for (const run of await workflow.runs()) assert.deepEqual(run.scope, scope);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP validates request identity, files and limits; a failed admission can retry with its original key', async () => {
  const directory = await mkdtemp(resolve('runtime-data/submission-http-')), store = new ExtractionStore(resolve(directory, 'db.sqlite')), legacy = new RunStore(resolve(directory, 'legacy.sqlite'));
  const fixture = gate(); let rejectPrepare = true;
  const workflow = new WorkbenchWorkflow(store, { ...fixture.options, directory, runner: { ...fixture.options.runner!, prepare: async () => { if (rejectPrepare) throw new ContractError('fixture_admission_denied'); } } });
  const app = buildApp(legacy, undefined, workflow);
  try {
    await app.ready();
    const upload = (payload: Buffer, id = 'upload-http-0001') => app.inject({ method: 'POST', url: '/api/workbench/papers', headers: { 'content-type': 'application/pdf', 'x-t1-filename': 'http.pdf', 'x-t1-request-id': id }, payload });
    assert.equal((await upload(PDF, 'bad')).statusCode, 400); assert.equal((await upload(Buffer.from('not a PDF'))).statusCode, 400);
    assert.equal((await upload(Buffer.alloc(MAX_PDF_BYTES + 1))).statusCode, 413);
    const paper = (await upload(PDF)).json().paper; assert.ok(paper.id); assert.equal((await upload(PDF)).json().paper.id, paper.id);
    const start = () => app.inject({ method: 'POST', url: `/api/workbench/papers/${paper.id}/runs`, headers: { 'x-t1-request-id': 'start-http-0001' }, payload: { scope: workflow.scopeCatalog().default_scope } });
    assert.equal((await start()).statusCode, 400); assert.equal((await workflow.runs()).length, 0);
    rejectPrepare = false; const accepted = await start(); assert.equal(accepted.statusCode, 202); const id = accepted.json().run.run_id;
    assert.equal((await start()).json().run.run_id, id); assert.equal((await workflow.runs()).length, 1);
  } finally { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
