import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow, type WorkflowOptions } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';

const PDF = Buffer.from('%PDF-1.4\n% TASK IDENTITY A\n%%EOF\n');
const PDF_OTHER = Buffer.from('%PDF-1.4\n% TASK IDENTITY B\n%%EOF\n');
async function setup(options: WorkflowOptions = {}) {
  const directory = await mkdtemp(resolve('runtime-data/task-identity-')), store = new ExtractionStore(resolve(directory, 'db.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { sources: false, ...options, directory });
  await workflow.initialize();
  return { directory, store, workflow, close: async () => { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
function gate() {
  const parsed: string[] = [];
  const options: WorkflowOptions = { runner: { controlled: true, provider: 'task-identity-gate', model_id: 'no-model', execute: async () => { throw new Error('model_execution_forbidden'); } },
    parse: async (input, _path, _directory, signal) => new Promise((_resolve, reject) => { parsed.push(input.run_id); const abort = () => reject(new ContractError('identity_gate_closed')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }) };
  return { parsed, options };
}
async function until(condition: () => boolean) { for (let n = 0; n < 150; n++) { if (condition()) return; await delay(10); } throw new Error('task_identity_fixture_timeout'); }

test('full-byte SHA deduplicates concurrent different requests and aliases, keeps different content, and preserves replay tombstones', async () => {
  const f = await setup();
  try {
    const values = await Promise.all(Array.from({ length: 12 }, (_, i) => f.workflow.upload(i % 2 ? PDF_OTHER : PDF, i < 6 ? 'same.pdf' : `alias-${i}.pdf`, undefined, `identity-upload-${i}`)));
    assert.equal(new Set(values.filter((_x, i) => i % 2 === 0).map(x => x.paper.id)).size, 1);
    assert.equal(new Set(values.filter((_x, i) => i % 2 === 1).map(x => x.paper.id)).size, 1);
    assert.notEqual(values[0]!.paper.id, values[1]!.paper.id); assert.equal((await f.workflow.papers()).length, 2);
    assert.equal((await readdir(resolve(f.directory, 'pdf'))).length, 2);
    assert.equal((await f.workflow.upload(PDF, 'same.pdf', undefined, 'identity-upload-0')).paper.id, values[0]!.paper.id);
    await assert.rejects(f.workflow.upload(PDF_OTHER, 'same.pdf', undefined, 'identity-upload-0'), /submission_payload_conflict/);
    await f.workflow.deletePaper(values[0]!.paper.id);
    await assert.rejects(f.workflow.upload(PDF, 'same.pdf', undefined, 'identity-upload-0'), /submission_result_deleted/);
    const next = await f.workflow.upload(PDF, 'new.pdf', undefined, 'identity-new-after-delete'); assert.notEqual(next.paper.id, values[0]!.paper.id);
  } finally { await f.close(); }
});

test('retained cross-path canonical papers are verified and reused without an orphan CAS copy or metadata rewrite', async () => {
  const f = await setup();
  try {
    const first = (await f.workflow.upload(PDF, 'original.pdf', 'Historical paper identity')).paper;
    const row = JSON.parse(f.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(first.id)!.payload_json as string);
    const retained = resolve(f.directory, 'retained/source.pdf'); await mkdir(resolve(f.directory, 'retained')); await rename(resolve(process.cwd(), row.pdf.path), retained);
    row.pdf.path = relative(process.cwd(), retained); row.uploaded = false;
    f.store.db.prepare('UPDATE workbench_papers SET payload_json=? WHERE id=?').run(JSON.stringify(row), first.id);
    const before = f.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(first.id)!.payload_json;
    const reused = await f.workflow.upload(PDF, 'renamed.pdf', 'Must not rewrite paper', 'retained-alias-upload');
    assert.equal(reused.paper.id, first.id); assert.equal(reused.reused, true); assert.equal(reused.paper.title, 'Historical paper identity');
    assert.equal(f.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(first.id)!.payload_json, before);
    assert.deepEqual(await readdir(resolve(f.directory, 'pdf')), []);
    await writeFile(retained, PDF_OTHER);
    await assert.rejects(f.workflow.upload(PDF, 'alias.pdf', undefined, 'retained-damaged-upload'), /source_integrity_blocked:pdf_source_sha_mismatch/);
    assert.equal((await f.workflow.papers()).length, 1); assert.deepEqual(await readdir(resolve(f.directory, 'pdf')), []);
  } finally { await f.close(); }
});

test('historical duplicate rows are not merged and deleting one reference keeps the shared PDF and retry identities', async () => {
  const f = await setup();
  try {
    const first = (await f.workflow.upload(PDF, 'first.pdf', 'First identity', 'historical-first-upload')).paper;
    const original = JSON.parse(f.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(first.id)!.payload_json as string);
    const old = { ...original, id: 'legacy-duplicate', title: 'Legacy identity', filename: 'legacy.pdf' };
    f.store.db.prepare('INSERT INTO workbench_papers VALUES(?,?)').run(old.id, JSON.stringify(old));
    const rows = f.store.db.prepare('SELECT payload_json FROM workbench_papers ORDER BY rowid').all();
    assert.equal((await f.workflow.upload(PDF, 'new.pdf', undefined, 'historical-new-upload')).paper.id, first.id);
    assert.deepEqual(f.store.db.prepare('SELECT payload_json FROM workbench_papers ORDER BY rowid').all(), rows);
    const removed = await f.workflow.deletePaper(first.id); assert.equal(removed.shared_pdf_retained, true);
    assert.deepEqual(await readFile(resolve(process.cwd(), old.pdf.path)), PDF);
    assert.equal((await f.workflow.upload(PDF, 'another.pdf', undefined, 'historical-next-upload')).paper.id, old.id);
    await f.workflow.deletePaper(old.id); await assert.rejects(readFile(resolve(process.cwd(), old.pdf.path)), /ENOENT/);
    await assert.rejects(f.workflow.upload(PDF, 'new.pdf', undefined, 'historical-new-upload'), /submission_result_deleted/);
  } finally { await f.close(); }
});

test('upload versus delete serializes content and never leaves a current paper pointing at a removed PDF', async () => {
  const f = await setup();
  try {
    const paper = (await f.workflow.upload(PDF, 'race.pdf')).paper;
    const outcomes = await Promise.allSettled([f.workflow.upload(PDF, 'alias.pdf', undefined, 'upload-delete-race'), f.workflow.deletePaper(paper.id)]);
    assert.equal(outcomes[1]!.status, 'fulfilled');
    const current = await f.workflow.papers(); assert.ok(current.length <= 1);
    for (const item of current) assert.deepEqual(await f.workflow.pdf(item.id), PDF);
    if (!current.length) assert.deepEqual(await readdir(resolve(f.directory, 'pdf')), []);
    const again = await f.workflow.upload(PDF, 'again.pdf', undefined, 'upload-after-delete-race'); assert.deepEqual(await f.workflow.pdf(again.paper.id), PDF);
  } finally { await f.close(); }
});

test('task titles and original filenames are independent run snapshots, with blank defaults and old payload replay intact', async () => {
  const g = gate(), f = await setup(g.options);
  try {
    const paper = (await f.workflow.upload(PDF, 'paper-source.pdf', 'Unverified source identity')).paper, scope = f.workflow.scopeCatalog().default_scope;
    const a = (await f.workflow.start(paper.id, scope, 'task-title-first', { kind: 'single' }, undefined, '  First task  ', 'incoming-name.pdf')).run;
    const b = (await f.workflow.start(paper.id, scope, 'task-title-second', { kind: 'single' }, undefined, 'Second task')).run;
    const blank = (await f.workflow.start(paper.id, scope, 'task-title-blank', { kind: 'single' }, undefined, '', 'blank-default.pdf')).run;
    assert.equal(a.task_title, 'First task'); assert.equal(a.original_filename, 'incoming-name.pdf'); assert.equal(b.task_title, 'Second task'); assert.equal(blank.task_title, 'blank-default.pdf');
    assert.notEqual(a.run_id, b.run_id); assert.equal((await f.workflow.papers())[0]!.title, 'Unverified source identity');
    assert.equal((await f.workflow.runDetail(a.run_id)).run.task_title, 'First task');
    assert.equal((await f.workflow.start(paper.id, scope, 'task-title-first', { kind: 'single' }, undefined, 'First task', 'incoming-name.pdf')).run.run_id, a.run_id);
    await assert.rejects(f.workflow.start(paper.id, scope, 'task-title-first', { kind: 'single' }, undefined, 'Changed', 'incoming-name.pdf'), /submission_payload_conflict/);
    const count = (await f.workflow.runs()).length;
    for (const title of [null, 42, 'x'.repeat(501), 'bad\nname']) await assert.rejects(f.workflow.start(paper.id, scope, undefined, undefined, undefined, title), /invalid_task_title/);
    await assert.rejects(f.workflow.start(paper.id, scope, undefined, undefined, undefined, 'ok', '../path.pdf'), /invalid_original_filename/);
    assert.equal((await f.workflow.runs()).length, count);
  } finally { await f.close(); }
});

test('batch titles freeze before admission, aliases share a member, different batches remain independent, and legacy batches gain no fake title', async () => {
  const g = gate(), f = await setup(g.options);
  try {
    const p = (await f.workflow.upload(PDF, 'one.pdf')).paper, other = (await f.workflow.upload(PDF_OTHER, 'two.pdf')).paper, scope = f.workflow.scopeCatalog().default_scope;
    const batch = { kind: 'batch' as const, batch_id: randomUUID() };
    const a = (await f.workflow.start(p.id, scope, 'batch-title-one', batch, undefined, 'Whole group', 'one.pdf')).run;
    const alias = (await f.workflow.start(p.id, scope, 'batch-title-alias', batch, undefined, 'Whole group', 'renamed.pdf')).run;
    assert.equal(alias.run_id, a.run_id);
    await assert.rejects(f.workflow.start(other.id, scope, 'batch-title-drift', batch, undefined, 'Changed group', 'two.pdf'), /batch_task_title_frozen/);
    const b = (await f.workflow.start(other.id, scope, 'batch-title-two', batch, undefined, 'Whole group', 'two.pdf')).run;
    assert.equal(b.task_title, 'Whole group'); assert.equal(b.original_filename, 'two.pdf');
    const next = (await f.workflow.start(p.id, scope, 'batch-next-group', { kind: 'batch', batch_id: randomUUID() }, undefined, 'Another group')).run; assert.notEqual(next.run_id, a.run_id);
    const legacyBatch = { kind: 'batch' as const, batch_id: randomUUID() };
    const legacy = (await f.workflow.start(p.id, scope, 'batch-legacy-title', legacyBatch)).run; assert.equal(legacy.task_title, undefined);
    await assert.rejects(f.workflow.start(other.id, scope, 'batch-legacy-inject', legacyBatch, undefined, 'Invented history'), /batch_task_title_frozen/);
  } finally { await f.close(); }
});

test('fresh starts ignore missing old IR while old run exports remain blocked; corrupt raw PDFs still reject starts', async () => {
  const saved = await controlledFixture({ delayMs: 1 }), titles: string[] = []; let parses = 0;
  const f = await setup({ parse: async (...args) => { parses++; return saved.parse!(...args); }, discover: saved.discover,
    runner: { controlled: true, provider: 'metadata-only-gate', model_id: 'no-model', execute: async context => {
      const identity = context.metadata.bibliographic_identity; assert.ok(identity); titles.push(identity.title ?? ''); context.store.transition(context.input.run_id, 'extracting'); context.store.transition(context.input.run_id, 'reconciling'); context.store.transition(context.input.run_id, 'completed'); return {};
    } } });
  try {
    const bytes = await readFile('evaluation/corpus/development-candidates/L01.pdf');
    const paper = (await f.workflow.upload(bytes, 'source-paper.pdf')).paper, scope = f.workflow.scopeCatalog().default_scope;
    const first = (await f.workflow.start(paper.id, scope, 'source-title-first', { kind: 'single' }, undefined, 'Task one')).run; await f.workflow.waitForIdle();
    const old = JSON.parse(f.store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(first.run_id)!.payload_json as string); assert.ok(old.source?.ir.path);
    await rm(resolve(process.cwd(), old.source.ir.path));
    assert.equal((await f.workflow.upload(bytes, 'alias.pdf', undefined, 'source-title-reupload')).paper.id, paper.id);
    const second = (await f.workflow.start(paper.id, scope, 'source-title-second', { kind: 'single' }, undefined, 'Task two')).run; await f.workflow.waitForIdle();
    assert.equal(parses, 2); assert.equal((await f.workflow.runs(second.run_id))[0]!.state, 'completed'); assert.deepEqual(titles, ['source-paper.pdf', 'source-paper.pdf']);
    await assert.rejects(f.workflow.export(first.run_id, 'retained_jsonl'), /source_integrity_blocked/);
    const currentPaper = JSON.parse(f.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(paper.id)!.payload_json as string);
    await writeFile(resolve(process.cwd(), currentPaper.pdf.path), Buffer.from('corrupt raw PDF'));
    await assert.rejects(f.workflow.start(paper.id, scope, 'source-title-damaged'), /source_integrity_blocked:pdf_source_sha_mismatch/); assert.equal(parses, 2);
  } finally { await f.close(); }
});

test('HTTP accepts task identity fields but still rejects server configuration overrides and normalizes reused upload status', async () => {
  const g = gate(), f = await setup(g.options), legacy = new RunStore(':memory:'), app = buildApp(legacy, undefined, f.workflow);
  try {
    await app.ready(); const upload = () => app.inject({ method: 'POST', url: '/api/workbench/papers', headers: { 'content-type': 'application/pdf', 'x-t1-filename': 'http.pdf' }, payload: PDF });
    const first = await upload(), reused = await upload(); assert.equal(first.statusCode, 201); assert.equal(reused.statusCode, 200); assert.equal(first.json().paper.id, reused.json().paper.id);
    const payload = { scope: f.workflow.scopeCatalog().default_scope, submission: { kind: 'single' }, task_title: 'HTTP task', original_filename: 'incoming.pdf' };
    const response = await app.inject({ method: 'POST', url: `/api/workbench/papers/${first.json().paper.id}/runs`, payload }); assert.equal(response.statusCode, 202); assert.equal(response.json().run.task_title, 'HTTP task');
    const refused = await app.inject({ method: 'POST', url: `/api/workbench/papers/${first.json().paper.id}/runs`, payload: { ...payload, provider: 'override' } }); assert.equal(refused.statusCode, 400);
  } finally { await app.close(); legacy.close(); await f.close(); }
});
