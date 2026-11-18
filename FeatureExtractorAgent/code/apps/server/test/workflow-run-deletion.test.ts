import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';
const replay = await controlledFixture({ delayMs: 1 });
const bytes = await readFile('evaluation/corpus/development-candidates/L01.pdf');
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function setup() { const directory = await mkdtemp(resolve('runtime-data/run-deletion-')); return { directory, store: new ExtractionStore(resolve(directory, 'test.sqlite')) }; }

test('single-run deletion clears only its records/exports and preserves paper, PDF, other runs and referenced source assets', { timeout: 60_000 }, async () => {
  const { directory, store } = await setup(), workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory }), legacy = new RunStore(':memory:'), app = buildApp(legacy, undefined, workflow);
  try {
    const paper = (await workflow.upload(bytes, 'keep-paper.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const first = (await workflow.start(paper.id, scope, 'delete-older-request')).run.run_id; await workflow.waitForIdle();
    const target = (await workflow.start(paper.id, scope, 'delete-target-request')).run.run_id; await workflow.waitForIdle();
    const readRow = (id: string) => JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(id)!.payload_json as string);
    const row = readRow(target), sibling = readRow(first), source = row.source;
    const native = resolve(row.directory, 'native-source.json'), result = resolve(row.directory, 'private-results.json');
    await writeFile(native, '{"source_only":true}'); await writeFile(result, '{"extraction_results":"must be deleted"}');
    source.document.native_artifact = { path: relative(workflow.codeRoot, native), sha256: createHash('sha256').update(await readFile(native)).digest('hex'), format: 'fixture-native' };
    const region = source.catalog?.figures.flatMap((figure: { regions: Array<{ path: string }> }) => figure.regions)[0];
    let image = '';
    if (region) { await mkdir(resolve(row.directory, 'shared-figures')); image = resolve(row.directory, 'shared-figures/image.png'); await writeFile(image, await readFile(resolve(workflow.codeRoot, region.path))); region.path = relative(workflow.codeRoot, image); }
    const paperRow = JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(paper.id)!.payload_json as string);
    paperRow.latest_source = source; sibling.source = structuredClone(source);
    store.db.prepare('UPDATE workbench_papers SET payload_json=? WHERE id=?').run(JSON.stringify(paperRow), paper.id);
    for (const item of [row, sibling]) store.db.prepare('UPDATE workbench_runs SET payload_json=? WHERE id=?').run(JSON.stringify(item), item.id);
    const record = (await workflow.runDetail(target)).output.records[0]!;
    await workflow.retainRecord(target, record.id, { expected_version: record.version, expected_retention_revision: 0, status: 'excluded' });
    await workflow.revise(target, record.id, { expected_version: record.version, reviewer: 'isolated-run-delete', labels: { comment: 'Fixture annotation.' } });
    store.db.prepare('INSERT INTO workbench_reviews VALUES(?,?,?,?)').run(target, record.id, record.version, '{}'); store.batch(target, 'fixture-batch', {});
    await workflow.export(target, 'candidate_package');
    const exports = store.db.prepare('SELECT payload_json FROM workbench_exports WHERE run_id=?').all(target).map(value => resolve(workflow.codeRoot, JSON.parse(value.payload_json as string).directory));
    const siblingBefore = await workflow.runDetail(first); siblingBefore.paper.output_ids = siblingBefore.paper.output_ids.filter(id => id !== target);
    const response = await app.inject({ method: 'DELETE', url: '/api/workbench/runs/' + target }); assert.equal(response.statusCode, 200); assert.equal(response.json().run_id, target);
    for (const table of ['workbench_annotations', 'workbench_reviews', 'workbench_retentions', 'workbench_exports', 's4_batches', 's4_versions', 's4_events']) assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`).get(target)!.n, 0, table);
    assert.equal((await workflow.papers()).length, 1); assert.equal((await workflow.runs()).length, 1); assert.deepEqual(await workflow.pdf(paper.id), bytes);
    assert.deepEqual(await workflow.runDetail(first), siblingBefore); assert.equal((await workflow.detail(paper.id)).source_status, 'valid');
    await access(native); await access(resolve(workflow.codeRoot, source.ir.path)); if (image) await access(image);
    await assert.rejects(access(result), /ENOENT/); for (const path of [...exports, ...exports.map(path => path + '.tar.gz')]) await assert.rejects(access(path), /ENOENT/);
    const replayRequest = await app.inject({ method: 'POST', url: '/api/workbench/papers/' + paper.id + '/runs', headers: { 'x-t1-request-id': 'delete-target-request' }, payload: { scope } });
    assert.equal(replayRequest.statusCode, 410); assert.equal(replayRequest.json().error, 'submission_result_deleted');
    assert.equal((await workflow.deleteRun(target)).already_deleted, true);
    await workflow.deleteRun(first); assert.equal((await workflow.runs()).length, 0); assert.equal((await workflow.papers()).length, 1); assert.deepEqual(await workflow.pdf(paper.id), bytes);
    assert.equal((await workflow.detail(paper.id)).source_status, 'valid');
    const rerun = (await workflow.start(paper.id, scope, 'delete-after-new-request')).run.run_id; await workflow.waitForIdle(); assert.notEqual(rerun, target);
  } finally { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('legacy run tombstones prevent reimport after restart without removing immutable evidence or the paper', { timeout: 60_000 }, async () => {
  const { directory, store } = await setup(); let workflow = new WorkbenchWorkflow(store, { directory });
  try {
    const run = (await workflow.runs()).find(run => run.document_id === 'L01')!; assert.ok(run);
    const source = workflow['run'](run.run_id).source!, original = await readFile(resolve(workflow.codeRoot, source.ir.path));
    await workflow.deleteRun(run.run_id); assert.ok((await workflow.papers()).some(paper => paper.id === 'L01'));
    await workflow.close(); workflow = new WorkbenchWorkflow(store, { directory }); await workflow.initialize();
    assert.ok(!(await workflow.runs()).some(item => item.run_id === run.run_id)); assert.deepEqual(await readFile(resolve(workflow.codeRoot, source.ir.path)), original);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM workbench_deleted_runs').get()!.n, 1); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM workbench_deleted_sources').get()!.n, 0);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a sibling Start preparation defers files without blocking deletion of an ended run', { timeout: 30_000 }, async () => {
  const { directory, store } = await setup(), entered = barrier(), finish = barrier(); let pause = false;
  const workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory, runner: { ...replay.runner!, prepare: async () => { if (pause) { entered.release(); await finish.promise; throw new ContractError('fixture_prepare_end'); } } } });
  try {
    const paper = (await workflow.upload(bytes, 'siblings.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const saved = (await workflow.start(paper.id, scope)).run.run_id; await workflow.waitForIdle();
    const privatePath = resolve(workflow['run'](saved).directory, 'private-results.json'); await writeFile(privatePath, '{}'); pause = true;
    const pending = workflow.start(paper.id, scope).then(() => 'unexpected', error => String(error)); await entered.promise;
    const deletion = await workflow.deleteRun(saved); assert.equal(deletion.deleted, true); assert.equal('cleanup_deferred' in deletion && deletion.cleanup_deferred, true);
    assert.equal((await workflow.runs()).length, 0); await access(privatePath);
    finish.release(); assert.match(await pending, /fixture_prepare_end/); await workflow.waitForIdle();
    await assert.rejects(access(privatePath), /ENOENT/); assert.equal((await workflow.deleteRun(saved)).already_deleted, true);
  } finally { finish.release(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('pending export writes block deletion and a failed export releases the guard for a safe retry', { timeout: 30_000 }, async () => {
  const { directory, store } = await setup(), workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory }), entered = barrier(), finish = barrier();
  let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(bytes, 'export.pdf')).paper, id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle();
    const nativeWrite = fs.writeFile;
    interceptor = mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith('human-annotations.json')) { entered.release(); await finish.promise; throw new Error('fixture_export_write_failed'); } return nativeWrite(...args);
    }); syncBuiltinESMExports();
    const exporting = workflow.export(id, 'candidate_jsonl').then(() => 'unexpected', error => String(error)); await entered.promise;
    await assert.rejects(workflow.deleteRun(id), /paper_busy_before_deleting_run/);
    finish.release(); assert.match(await exporting, /fixture_export_write_failed/); assert.equal((await workflow.deleteRun(id)).deleted, true);
  } finally { finish.release(); interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a sibling export defers cleanup and its write-guard release resumes it without altering that sibling', { timeout: 30_000 }, async () => {
  const { directory, store } = await setup(), workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory }), entered = barrier(), finish = barrier();
  let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(bytes, 'sibling-export.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const target = (await workflow.start(paper.id, scope)).run.run_id; await workflow.waitForIdle();
    const path = resolve(workflow['run'](target).directory, 'private-results.json'); await writeFile(path, '{}');
    const sibling = (await workflow.start(paper.id, scope)).run.run_id; await workflow.waitForIdle();
    const before = (await workflow.runDetail(sibling)).output, nativeWrite = fs.writeFile;
    interceptor = mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith('human-annotations.json')) { entered.release(); await finish.promise; throw new Error('fixture_sibling_export_failed'); }
      return nativeWrite(...args);
    }); syncBuiltinESMExports();
    const exporting = workflow.export(sibling, 'candidate_jsonl').then(() => 'unexpected', error => String(error)); await entered.promise;
    const deletion = await workflow.deleteRun(target); assert.equal('cleanup_deferred' in deletion && deletion.cleanup_deferred, true); await access(path);
    finish.release(); assert.match(await exporting, /fixture_sibling_export_failed/);
    for (let attempt = 0; attempt < 300 && JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(target)!.payload_json as string).status !== 'complete'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(access(path), /ENOENT/); assert.deepEqual((await workflow.runDetail(sibling)).output, before);
  } finally { finish.release(); interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('direct cleanup keeps pending-plan notifications and releases them after success without failure self-retry', { timeout: 30_000 }, async () => {
  const { directory, store } = await setup(), workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory }), entered = barrier(), finish = barrier();
  let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(bytes, 'cleanup-wakeup.pdf')).paper, ids: string[] = [], roots: string[] = [];
    for (let i = 0; i < 2; i++) { const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle(); ids.push(id); roots.push(workflow['run'](id).directory); await writeFile(resolve(roots[i]!, 'private-results.json'), '{}'); }
    const nativeRm = fs.rm;
    interceptor = mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => { if (roots.some(root => String(args[0]).startsWith(root))) throw new Error('fixture_cleanup_unavailable'); return nativeRm(...args); }); syncBuiltinESMExports();
    for (const id of ids) await assert.rejects(workflow.deleteRun(id), /run_deleted_cleanup_pending/);
    interceptor.mock.restore();
    interceptor = mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => { if (String(args[0]).startsWith(roots[0]!)) { entered.release(); await finish.promise; } return nativeRm(...args); }); syncBuiltinESMExports();
    const deleting = workflow.deleteRun(ids[0]!); await entered.promise;
    // This safe-point notification arrives while explicit cleanup owns files.
    await workflow.waitForIdle(); finish.release(); assert.equal((await deleting).deleted, true);
    for (let attempt = 0; attempt < 300 && JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(ids[1]!)!.payload_json as string).status !== 'complete'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    for (const id of ids) assert.equal(JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(id)!.payload_json as string).status, 'complete');
    for (const root of roots) await assert.rejects(access(resolve(root, 'private-results.json')), /ENOENT/);
  } finally { finish.release(); interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cleanup failures keep a durable pending plan; repeated DELETE and restart finish cleanup without reviving a run', { timeout: 40_000 }, async () => {
  const { directory, store } = await setup(), legacy = new RunStore(':memory:');
  let workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory }), app = buildApp(legacy, undefined, workflow);
  let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(bytes, 'cleanup-retry.pdf')).paper;
    for (const mode of ['retry', 'restart']) {
      const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle();
      const path = resolve(workflow['run'](id).directory, 'private-extraction-results.json'); await writeFile(path, '{"fixture_private_result":true}');
      const nativeRm = fs.rm;
      interceptor = mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => { if (String(args[0]) === path) throw new Error('controlled_cleanup_failure'); return nativeRm(...args); }); syncBuiltinESMExports();
      const failed = await app.inject({ method: 'DELETE', url: '/api/workbench/runs/' + id });
      assert.equal(failed.statusCode, 503); assert.equal(failed.json().error, 'run_deleted_cleanup_pending'); assert.equal(failed.json().deleted, true);
      assert.ok(!(await workflow.runs()).some(run => run.run_id === id)); await access(path);
      const plan = () => JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(id)!.payload_json as string);
      assert.equal(plan().status, 'cleanup_pending'); assert.ok(plan().targets.length);
      interceptor.mock.restore(); interceptor = undefined; syncBuiltinESMExports();
      if (mode === 'restart') { await app.close(); workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory }); app = buildApp(legacy, undefined, workflow); await app.ready(); }
      const retried = await app.inject({ method: 'DELETE', url: '/api/workbench/runs/' + id }); assert.equal(retried.statusCode, 200);
      assert.equal(plan().status, 'complete'); await assert.rejects(access(path), /ENOENT/);
      assert.equal((await workflow.runs()).length, 0); assert.deepEqual(await workflow.pdf(paper.id), bytes);
    }
  } finally { interceptor?.mock.restore(); syncBuiltinESMExports(); await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('realpath permission and IO errors keep cleanup pending; only missing paths count as already removed', { timeout: 30_000 }, async () => {
  const { directory, store } = await setup(), workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory });
  let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await workflow.upload(bytes, 'realpath-retry.pdf')).paper;
    for (const code of ['EACCES', 'EIO']) {
      const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle();
      const row = workflow['run'](id), path = code === 'EACCES' ? resolve(workflow.codeRoot, row.source!.ir.path) : row.directory;
      const nativeRealpath = fs.realpath;
      interceptor = mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => { if (String(args[0]) === path) throw Object.assign(new Error('controlled_realpath_' + code), { code }); return nativeRealpath(...args); }); syncBuiltinESMExports();
      await assert.rejects(workflow.deleteRun(id), /run_deleted_cleanup_pending/);
      assert.equal(JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(id)!.payload_json as string).status, 'cleanup_pending');
      interceptor.mock.restore(); interceptor = undefined; syncBuiltinESMExports();
      await workflow.deleteRun(id); assert.equal(JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(id)!.payload_json as string).status, 'complete');
    }
  } finally { interceptor?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
