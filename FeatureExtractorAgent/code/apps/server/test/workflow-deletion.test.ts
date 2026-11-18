import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';

const PDF = Buffer.from('%PDF-1.4\n% ISOLATED DELETION ENGINEERING STUB\n%%EOF\n');
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function sandbox() {
  const directory = await mkdtemp(resolve('runtime-data/workflow-deletion-'));
  return { directory, store: new ExtractionStore(resolve(directory, 'test.sqlite')) };
}
function pdfPath(workflow: WorkbenchWorkflow, id: string) {
  const row = workflow.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(id)!;
  return resolve(workflow.codeRoot, JSON.parse(row.payload_json as string).pdf.path);
}
/** Older databases may contain distinct paper identities sharing one PDF.
 * New uploads now deduplicate, so seed that legacy state explicitly. */
function legacySharedPaper(workflow: WorkbenchWorkflow, id: string) {
  const row = JSON.parse(workflow.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(id)!.payload_json as string);
  row.id = id + '-legacy'; row.title = 'legacy-other.pdf'; row.filename = 'legacy-other.pdf';
  workflow.store.db.prepare('INSERT INTO workbench_papers VALUES(?,?)').run(row.id, JSON.stringify(row));
  return { id: row.id as string };
}
const replay = await controlledFixture({ delayMs: 1 });

for (const terminal of ['completed', 'partial', 'failed', 'cancelled', 'interrupted'] as const) {
  test(`paper deletion refuses ${terminal} while its coordinator is still saving`, { timeout: 30_000 }, async () => {
    const { directory, store } = await sandbox(), entered = barrier(), finish = barrier();
    const workflow = new WorkbenchWorkflow(store, { sources: false, directory, parse: replay.parse, discover: replay.discover,
      runner: { controlled: true, provider: 'deletion-fixture', model_id: 'no-model-call', execute: async context => {
        context.store.transition(context.input.run_id, 'extracting'); context.store.transition(context.input.run_id, 'reconciling');
        context.store.transition(context.input.run_id, terminal); entered.release(); await finish.promise;
        return { coverage: { paid_requests: 0 }, summary: 'Controlled delayed final save.' };
      } } });
    try {
      const paper = (await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), terminal + '.pdf')).paper;
      const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await entered.promise;
      assert.equal(store.snapshot(id).state, terminal);
      await assert.rejects(workflow.deleteRun(id), /paper_busy_before_deleting_run/);
      await assert.rejects(workflow.deletePaper(paper.id), /cancel_active_runs_before_deleting_paper/);
      assert.equal((await workflow.papers()).length, 1); assert.equal((await workflow.runs()).length, 1);
      finish.release(); await workflow.waitForIdle();
      assert.ok(workflow.events(id).some(event => event.type === 'run_result_saved'));
      assert.equal((await workflow.deletePaper(paper.id)).runs_deleted, 1);
    } finally { finish.release(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('cancelled parser must exit before deletion; queued and active tasks remain guarded', { timeout: 30_000 }, async () => {
  const { directory, store } = await sandbox(), entered = barrier(), finish = barrier();
  const workflow = new WorkbenchWorkflow(store, { sources: false, directory,
    runner: { controlled: true, provider: 'deletion-fixture', model_id: 'no-model-call', execute: async () => { throw new Error('unexpected_model_execution'); } },
    parse: async () => { entered.release(); await finish.promise; throw new ContractError('controlled_parser_exit'); } });
  try {
    const paper = (await workflow.upload(PDF, 'cancel.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await workflow.start(paper.id, scope)).run.run_id);
    await entered.promise; assert.equal(store.snapshot(ids[2]!).state, 'queued');
    await assert.rejects(workflow.deletePaper(paper.id), /cancel_active_runs_before_deleting_paper/);
    for (const id of ids) await workflow.cancel(id);
    assert.equal(store.snapshot(ids[0]!).state, 'cancelled');
    await assert.rejects(workflow.deleteRun(ids[0]!), /paper_busy_before_deleting_run/);
    await assert.rejects(workflow.deletePaper(paper.id), /cancel_active_runs_before_deleting_paper/);
    finish.release(); await workflow.waitForIdle();
    assert.equal((await workflow.deletePaper(paper.id)).runs_deleted, 3);
  } finally { finish.release(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('every overlapping Start preparation blocks deletion and failed admission releases its guard', { timeout: 30_000 }, async () => {
  const { directory, store } = await sandbox(), prepared = [barrier(), barrier()], entered = [barrier(), barrier()]; let count = 0;
  const workflow = new WorkbenchWorkflow(store, { sources: false, directory,
    runner: { controlled: true, provider: 'deletion-fixture', model_id: 'no-model-call',
      prepare: async () => { const index = count++; entered[index]!.release(); await prepared[index]!.promise; throw new ContractError('controlled_prepare_failed'); },
      execute: async () => { throw new Error('unexpected_model_execution'); } } });
  const legacy = new RunStore(':memory:'), app = buildApp(legacy, undefined, workflow);
  try {
    const paper = (await workflow.upload(PDF, 'prepare.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const pending = [workflow.start(paper.id, scope).then(() => 'unexpected_success', error => String(error)), workflow.start(paper.id, scope).then(() => 'unexpected_success', error => String(error))];
    await Promise.all(entered.map(item => item.promise)); assert.equal((await workflow.runs()).length, 0);
    const refused = await app.inject({ method: 'DELETE', url: '/api/workbench/papers/' + paper.id });
    assert.equal(refused.statusCode, 409); assert.equal(refused.json().error, 'cancel_active_runs_before_deleting_paper');
    prepared[0]!.release(); assert.match(await pending[0]!, /controlled_prepare_failed/);
    await assert.rejects(workflow.deletePaper(paper.id), /cancel_active_runs_before_deleting_paper/);
    prepared[1]!.release(); assert.match(await pending[1]!, /controlled_prepare_failed/);
    assert.equal((await workflow.deletePaper(paper.id)).runs_deleted, 0);
  } finally { for (const gate of prepared) gate.release(); await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('delete-first PDF unlink serializes a same-SHA upload and rejects new Starts until cleanup exits', { timeout: 30_000 }, async () => {
  const { directory, store } = await sandbox(), entered = barrier(), unlink = barrier();
  const workflow = new WorkbenchWorkflow(store, { sources: false, directory }); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(PDF, 'first.pdf')).paper, path = pdfPath(workflow, paper.id), nativeRm = fs.rm;
    interceptor = mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === path) { entered.release(); await unlink.promise; }
      return nativeRm(...args);
    }); syncBuiltinESMExports();
    const deleting = workflow.deletePaper(paper.id); await entered.promise;
    await assert.rejects(workflow.start(paper.id, workflow.scopeCatalog().default_scope), /paper_deletion_in_progress/);
    await assert.rejects(workflow.deletePaper(paper.id), /paper_deletion_in_progress/);
    await assert.rejects(workflow.restorePdf(paper.id, PDF), /workbench_paper_not_found/);
    let uploaded = false;
    const pending = workflow.upload(PDF, 'second.pdf').then(value => { uploaded = true; return value; });
    await delay(20); assert.equal(uploaded, false);
    unlink.release(); assert.equal((await deleting).shared_pdf_retained, false);
    const duplicate = (await pending).paper; assert.deepEqual(await workflow.pdf(duplicate.id), PDF);
    await assert.rejects(workflow.start(paper.id, workflow.scopeCatalog().default_scope), /workbench_paper_not_found/);
  } finally { unlink.release(); interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('upload reuse check serializes deletion and refuses reuse and a stale queued restore once deletion starts', { timeout: 30_000 }, async () => {
  const { directory, store } = await sandbox(), entered = barrier(), write = barrier();
  const workflow = new WorkbenchWorkflow(store, { sources: false, directory }); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(PDF, 'first.pdf')).paper, path = pdfPath(workflow, paper.id), nativeRead = fs.readFile;
    interceptor = mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path) { entered.release(); await write.promise; }
      return nativeRead(...args);
    }); syncBuiltinESMExports();
    const pending = workflow.upload(PDF, 'second.pdf').then(() => 'unexpected_success', error => String(error)); await entered.promise;
    const restoring = workflow.restorePdf(paper.id, PDF).then(() => 'unexpected_success', error => String(error));
    let deleted = false;
    const deleting = workflow.deletePaper(paper.id).then(value => { deleted = true; return value; });
    await delay(20); assert.equal(deleted, false);
    write.release(); assert.match(await pending, /paper_deletion_in_progress/);
    assert.match(await restoring, /paper_deletion_in_progress/);
    assert.equal((await deleting).shared_pdf_retained, false); await assert.rejects(access(path), /ENOENT/);
  } finally { write.release(); interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('restore-first PDF write finishes before deletion unlinks it and cannot recreate an orphan', { timeout: 30_000 }, async () => {
  const { directory, store } = await sandbox(), entered = barrier(), write = barrier();
  const workflow = new WorkbenchWorkflow(store, { sources: false, directory }); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(PDF, 'restore.pdf')).paper, path = pdfPath(workflow, paper.id), nativeWrite = fs.writeFile;
    interceptor = mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]) === path) { entered.release(); await write.promise; } return nativeWrite(...args);
    }); syncBuiltinESMExports();
    const restoring = workflow.restorePdf(paper.id, PDF); await entered.promise;
    let deleted = false;
    const deleting = workflow.deletePaper(paper.id).then(value => { deleted = true; return value; });
    await delay(20); assert.equal(deleted, false);
    write.release(); assert.equal((await restoring).restored, true); await deleting;
    assert.equal((await workflow.papers()).length, 0); await assert.rejects(access(path), /ENOENT/);
  } finally { write.release(); interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('PDF cleanup failure releases deletion and file guards', { timeout: 30_000 }, async () => {
  const { directory, store } = await sandbox(), workflow = new WorkbenchWorkflow(store, { sources: false, directory });
  let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(PDF, 'failure.pdf')).paper, path = pdfPath(workflow, paper.id), nativeRm = fs.rm;
    interceptor = mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === path) throw new Error('controlled_unlink_failure'); return nativeRm(...args);
    }); syncBuiltinESMExports();
    await assert.rejects(workflow.deletePaper(paper.id), /controlled_unlink_failure/);
    await assert.rejects(workflow.start(paper.id, workflow.scopeCatalog().default_scope), /workbench_paper_not_found/);
    const duplicate = (await workflow.upload(PDF, 'after-failure.pdf')).paper; assert.deepEqual(await workflow.pdf(duplicate.id), PDF);
  } finally { interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('paper deletion removes all its runs and saved artifacts while preserving another paper and its shared PDF', { timeout: 60_000 }, async () => {
  const { directory, store } = await sandbox(), workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory });
  try {
    const bytes = await readFile('evaluation/corpus/development-candidates/L01.pdf');
    const target = (await workflow.upload(bytes, 'target.pdf')).paper, other = legacySharedPaper(workflow, target.id);
    const ids = [];
    for (const paper of [target, target, other]) { ids.push((await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id); await workflow.waitForIdle(); }
    for (const id of ids.slice(0, 2)) {
      const record = (await workflow.runDetail(id!)).output.records[0]!; assert.ok(record);
      await workflow.retainRecord(id!, record.id, { expected_version: record.version, expected_retention_revision: 0, status: 'excluded' });
      await workflow.revise(id!, record.id, { expected_version: record.version, reviewer: 'isolated-delete-test', labels: { comment: 'Deletion fixture.' } });
      store.db.prepare('INSERT INTO workbench_reviews VALUES(?,?,?,?)').run(id!, record.id, record.version, '{}');
      store.batch(id!, 'isolated-batch', { paid_requests: 0 });
      await workflow.export(id!, 'candidate_package');
    }
    const targetDirectories = store.db.prepare('SELECT payload_json FROM workbench_runs WHERE paper_id=?').all(target.id).map(value => JSON.parse(value.payload_json as string).directory as string);
    const exportDirectories = store.db.prepare('SELECT payload_json FROM workbench_exports').all().map(value => resolve(workflow.codeRoot, JSON.parse(value.payload_json as string).directory));
    const otherBefore = JSON.stringify(await workflow.runDetail(ids[2]!));
    const deletion = await workflow.deletePaper(target.id); assert.equal(deletion.runs_deleted, 2); assert.equal(deletion.shared_pdf_retained, true);
    for (const id of ids.slice(0, 2)) for (const table of ['workbench_annotations', 'workbench_reviews', 'workbench_retentions', 'workbench_exports', 's4_batches', 's4_versions', 's4_events']) assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`).get(id!)!.n, 0, table);
    assert.equal((await workflow.runs()).length, 1); assert.equal(JSON.stringify(await workflow.runDetail(ids[2]!)), otherBefore);
    assert.deepEqual(await workflow.pdf(other.id), bytes);
    for (const path of [...targetDirectories, ...exportDirectories, ...exportDirectories.map(path => path + '.tar.gz')]) await assert.rejects(access(path), /ENOENT/);
    assert.ok(store.db.prepare('SELECT paper_id FROM workbench_deleted_sources WHERE paper_id=?').get(target.id));
    await workflow.deletePaper(other.id); await assert.rejects(access(resolve(directory, 'pdf', target.sha256 + '.pdf')), /ENOENT/);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
