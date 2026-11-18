import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import nativeFs, { type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, symlink, link } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow, type WorkflowOptions } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import type { WorkbenchStoragePreview } from '../../../packages/contracts/src/workbench.js';

const HOUR = 3600_000, bytes = Buffer.from('%PDF-1.4\nIsolated storage engineering fixture\n%%EOF');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const barrier = () => { let release!: () => void; const promise = new Promise<void>(accept => { release = accept; }); return { release, promise }; };
async function fixture(options: WorkflowOptions = {}, recent = false) {
  const root = await mkdtemp(resolve('runtime-data/storage-management-test-')), database = resolve(root, 'runtime-data/t1.sqlite');
  const legacy = new RunStore(database), store = new ExtractionStore(database);
  let clock = Date.now() + (recent ? 0 : 48 * HOUR);
  const workflow = new WorkbenchWorkflow(store, { codeRoot: root, directory: 'runtime-data/workbench', sources: false, storageNow: () => clock, ...options });
  const app = buildApp(legacy, undefined, workflow); await app.ready();
  const file = async (path: string, value = '{}') => { const target = resolve(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value); return target; };
  const upload = async (suffix = '') => workflow.upload(suffix ? Buffer.from(bytes.toString() + suffix + '\n%%EOF') : bytes, 'fixture' + suffix + '.pdf');
  const cleanup = (preview: WorkbenchStoragePreview, ids = preview.candidates.map(candidate => candidate.id)) => workflow.storageCleanupSelection({ preview_id: preview.preview_id, version: preview.version, candidate_ids: ids });
  const close = async () => { await app.close(); legacy.close(); store.close(); await rm(root, { recursive: true, force: true }); };
  const paper = (id: string) => JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(id)!.payload_json as string);
  const savePaper = (value: { id: string }) => store.db.prepare('INSERT INTO workbench_papers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(value.id, JSON.stringify(value));
  const seedRun = (paperId: string, directory?: string, state = 'completed') => {
    const id = 'run-' + randomUUID(), row = paper(paperId);
    const input = { schema_version: '1', run_id: id, document_id: paperId, file_sha256: row.pdf.sha256, fixture: false, scope: workflow.scopeCatalog().default_scope,
      rule_version: 'storage-fixture-1', runtime_profile: { provider: 'fixture', model_id: 'no-model', endpoint: '', pi_version: '1.4.0', version: 'fixture-1' } } as const;
    store.create(input, { controlled_storage_fixture: true }); store.db.prepare('UPDATE s4_runs SET state=? WHERE id=?').run(state, id);
    store.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?)').run(id, paperId, JSON.stringify({ id, paper_id: paperId, created_at: new Date().toISOString(),
      origin: 'controlled_fixture', controlled: true, directory: directory ?? resolve(workflow.directory, 'runs', id) }));
    return id;
  };
  return { root, store, workflow, app, file, upload, cleanup, close, paper, savePaper, seedRun, advance: (duration: number) => { clock += duration; } };
}

test('storage stats separate file size from disk space, count only managed roots and never expose paths', async () => {
  const f = await fixture();
  try {
    const uploaded = await f.upload(), id = 'run-' + randomUUID();
    await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', id, 'document-ir.json')), 'parse');
    await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', id, 'pi-config', 'auth.json')), 'PRIVATE-FIXTURE-DO-NOT-EXPOSE');
    await f.file('outside/backup.pdf', 'excluded');
    const response = await f.app.inject('/api/workbench/storage'), summary = response.json();
    assert.equal(response.statusCode, 200); assert.equal(summary.total_bytes, bytes.length + 5 + 'PRIVATE-FIXTURE-DO-NOT-EXPOSE'.length);
    assert.equal(summary.total_bytes, summary.protected_bytes + summary.reclaimable_bytes + summary.unknown_bytes);
    assert.ok(summary.disk.total_bytes > summary.total_bytes); assert.ok(summary.disk.available_bytes >= 0);
    assert.equal(summary.policy.automatic_cleanup, false); assert.equal(summary.policy.recent_upload_protection_hours, 24);
    const preview = await f.workflow.storagePreview({}); assert.ok(preview.candidates.some(candidate => candidate.paper_ids.includes(uploaded.paper.id)));
    assert.ok(preview.candidates.some(candidate => candidate.kind === 'orphan_parse'));
    const text = JSON.stringify(preview); assert.ok(!text.includes(f.root)); assert.ok(!text.includes('PRIVATE-FIXTURE')); assert.ok(!text.includes('auth.json'));
    assert.equal(Date.parse(preview.expires_at) - Date.parse(preview.created_at), 10 * 60_000);
  } finally { await f.close(); }
});

test('fresh uploads, idle browser drafts, legacy timestamps and repeated same-content uploads receive 24h protection', async () => {
  const f = await fixture({}, true);
  try {
    const uploaded = await f.upload(); assert.equal((await f.workflow.storagePreview({})).candidates.length, 0);
    f.advance(23 * HOUR); assert.equal((await f.workflow.storagePreview({})).candidates.length, 0);
    f.advance(2 * HOUR); assert.equal((await f.workflow.storagePreview({})).candidates.length, 1);
    const row = f.paper(uploaded.paper.id); delete row.uploaded_at; delete row.last_uploaded_at; f.savePaper(row);
    assert.equal((await f.workflow.storagePreview({})).candidates.length, 1); // Legacy fallback uses the most recent filesystem timestamp.
    const future = new Date(Date.now() + 30 * HOUR).toISOString(); row.last_uploaded_at = future; f.savePaper(row);
    assert.equal((await f.workflow.storagePreview({})).candidates.length, 0);
  } finally { await f.close(); }
  const repeated = await fixture();
  try {
    await repeated.upload(); const preview = await repeated.workflow.storagePreview({}); assert.equal(preview.candidates.length, 1);
    await repeated.upload(); await assert.rejects(repeated.cleanup(preview), /storage_preview_stale/);
    const value = repeated.paper((await repeated.workflow.papers())[0]!.id); assert.ok(value.last_uploaded_at);
  } finally { await repeated.close(); }
});

test('terminal and zero-result runs, legacy runs, historical versions, reviews and export references protect their sources', async () => {
  const f = await fixture();
  try {
    const current = (await f.upload()).paper, run = f.seedRun(current.id);
    const runDir = resolve(f.workflow.directory, 'runs', run), file = await f.file(relative(f.root, resolve(runDir, 'result.json')), 'saved-result');
    const versionFile = await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', 'run-' + randomUUID(), 'document-ir.json')), 'historical-ir');
    f.store.db.prepare('INSERT INTO s4_versions VALUES(?,?,?,?)').run(run, 'record', 1, JSON.stringify({ source_version: { path: relative(f.root, versionFile) } }));
    const reviewFile = await f.file(relative(f.root, resolve(f.workflow.directory, 'figure-reviews', 'a'.repeat(64), randomUUID() + '.json')), 'review');
    f.store.db.prepare('INSERT INTO workbench_reviews VALUES(?,?,?,?)').run(run, 'record', 1, JSON.stringify({ evidence: { path: relative(f.root, reviewFile) } }));
    const exp = 'export-' + randomUUID(), expDir = resolve(f.workflow.directory, 'exports', exp);
    await f.file(relative(f.root, resolve(expDir, 'manifest.json')), 'export'); await f.file(relative(f.root, expDir + '.tar.gz'), 'archive');
    f.store.db.prepare('INSERT INTO workbench_exports VALUES(?,?,?)').run(exp, run, JSON.stringify({ directory: relative(f.root, expDir) }));
    const second = (await f.upload('legacy')).paper, secondRow = f.paper(second.id);
    f.store.db.prepare('INSERT INTO runs VALUES(?,?,?)').run('legacy-run', JSON.stringify({ document_id: second.id, file_sha256: secondRow.pdf.sha256 }), 'completed');
    assert.equal((await f.workflow.storagePreview({})).candidates.length, 0);
    await access(file); await access(versionFile); await access(reviewFile); await access(expDir + '.tar.gz');
  } finally { await f.close(); }
});

test('same-SHA legacy papers form one explicit candidate, and a live shared reference prevents cleanup', async () => {
  const f = await fixture();
  try {
    const first = (await f.upload()).paper, sibling = { ...f.paper(first.id), id: 'paper-' + randomUUID(), title: 'Historical duplicate' }; f.savePaper(sibling);
    const preview = await f.workflow.storagePreview({}); assert.equal(preview.candidates.length, 1);
    assert.deepEqual(preview.candidates[0]!.paper_ids.sort(), [first.id, sibling.id].sort()); assert.equal(preview.candidates[0]!.bytes, bytes.length);
    f.seedRun(sibling.id); await assert.rejects(f.cleanup(preview), /storage_preview_stale/);
    assert.equal((await f.workflow.storagePreview({})).candidates.length, 0); assert.deepEqual(await f.workflow.pdf(first.id), bytes);
  } finally { await f.close(); }
  const removable = await fixture();
  try {
    const first = (await removable.upload()).paper, duplicate = { ...removable.paper(first.id), id: 'paper-' + randomUUID() }; removable.savePaper(duplicate);
    const result = await removable.cleanup(await removable.workflow.storagePreview({}));
    assert.equal(result.removed_files, 1); assert.equal(result.removed_paper_ids.length, 2); assert.equal((await removable.workflow.papers()).length, 0);
  } finally { await removable.close(); }
});

test('known isolated orphan files are removed selectively; unknown neighbors and pi-config survive', async () => {
  const f = await fixture();
  try {
    const id = 'run-' + randomUUID(), dir = resolve(f.workflow.directory, 'runs', id);
    const known = await f.file(relative(f.root, resolve(dir, 'document-ir.json')), 'IR');
    const unknown = await f.file(relative(f.root, resolve(dir, 'user-notes.txt')), 'keep');
    const privateFile = await f.file(relative(f.root, resolve(dir, 'pi-config', 'models.json')), 'private');
    const exportDir = resolve(f.workflow.directory, 'exports', 'export-' + randomUUID()); await f.file(relative(f.root, resolve(exportDir, 'manifest.json')), 'export');
    const preview = await f.workflow.storagePreview({}), target = preview.candidates.find(candidate => candidate.kind === 'orphan_parse')!;
    const result = await f.cleanup(preview, [target.id]); assert.equal(result.status, 'complete'); assert.equal(result.removed_bytes, 2);
    await assert.rejects(access(known), /ENOENT/); await access(unknown); await access(privateFile); await access(resolve(exportDir, 'manifest.json'));
    assert.ok(result.summary.reclaimable_bytes > 0); assert.equal(result.summary.unknown_bytes, 11);
  } finally { await f.close(); }
});

test('unused upload cleanup includes its exclusively owned parsed sources and keeps other paper sources', async () => {
  const f = await fixture();
  try {
    const paper = (await f.upload()).paper, row = f.paper(paper.id), id = 'run-' + randomUUID();
    const ir = await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', id, 'document-ir.json')), 'IR');
    const figure = await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', id, 'figure-assets', 'figure-' + 'b'.repeat(24) + '-p1-0.png')), 'image');
    row.latest_source = { ir: { path: relative(f.root, ir), sha256: hash('IR') }, catalog: { figures: [{ regions: [{ path: relative(f.root, figure), sha256: hash('image') }] }] } }; f.savePaper(row);
    const preview = await f.workflow.storagePreview({}); assert.equal(preview.candidates.length, 1); const candidate = preview.candidates[0]!;
    assert.equal(candidate.kind, 'unused_upload'); assert.equal(candidate.files, 3); assert.equal(candidate.parts.find(part => part.kind === 'figures')!.bytes, 5);
    const result = await f.cleanup(preview); assert.equal(result.removed_files, 3); assert.deepEqual(result.removed_paper_ids, [paper.id]);
    await assert.rejects(access(ir), /ENOENT/); await assert.rejects(access(figure), /ENOENT/);
    assert.equal((await f.workflow.papers()).length, 0);
  } finally { await f.close(); }
});

test('native parser root requires a known workbench run identity and protects historical development artifacts', async () => {
  const f = await fixture();
  try {
    const known = 'run-' + randomUUID(), unknown = 'run-' + randomUUID();
    f.store.db.prepare('INSERT INTO workbench_deleted_runs VALUES(?,?,?,?)').run(known, 'deleted-paper', new Date().toISOString(), JSON.stringify({ status: 'complete', targets: [] }));
    const owned = await f.file(`runtime-data/s3-native-artifacts/${known}/docling-standard-cpu-${'c'.repeat(64)}.json`, 'known-native');
    const historical = await f.file(`runtime-data/s3-native-artifacts/${unknown}/docling-standard-cpu-${'d'.repeat(64)}.json`, 'historical-native');
    const preview = await f.workflow.storagePreview({}); assert.equal(preview.candidates.length, 1); assert.equal(preview.summary.unknown_bytes, 'historical-native'.length);
    const result = await f.cleanup(preview); assert.equal(result.removed_bytes, 'known-native'.length);
    await assert.rejects(access(owned), /ENOENT/); await access(historical);
  } finally { await f.close(); }
});

test('hard links are inode-deduplicated and protected; symbolic links are never followed', async () => {
  const f = await fixture();
  try {
    const paper = (await f.upload()).paper, path = resolve(f.root, f.paper(paper.id).pdf.path), twin = resolve(f.workflow.directory, 'pdf', 'f'.repeat(64) + '.pdf');
    await link(path, twin); const outside = await f.file('outside/source.json', 'outside');
    const id = 'run-' + randomUUID(), dir = resolve(f.workflow.directory, 'runs', id); await mkdir(dir, { recursive: true }); await symlink(outside, resolve(dir, 'document-ir.json'));
    const preview = await f.workflow.storagePreview({}); assert.equal(preview.candidates.length, 0);
    assert.equal(preview.summary.total_bytes, bytes.length); assert.equal(preview.summary.protected_reasons.find(reason => reason.code === 'unsafe_link')!.files, 2);
    assert.equal(await readFile(outside, 'utf8'), 'outside'); await access(twin);
  } finally { await f.close(); }
});

test('symlinked scope roots fail closed and preview-time parent replacement cannot redirect deletion', async () => {
  const f = await fixture();
  try {
    await f.upload(); const external = resolve(f.root, 'external'); await mkdir(external);
    await symlink(external, resolve(f.workflow.directory, 'exports'));
    const preview = await f.workflow.storagePreview({}); assert.equal(preview.summary.cleanup_available, false); assert.equal(preview.summary.unavailable_reason, 'storage_scope_unavailable'); assert.equal(preview.candidates.length, 0);
    await rm(resolve(f.workflow.directory, 'exports')); const good = await f.workflow.storagePreview({}); assert.equal(good.candidates.length, 1);
    const pdf = resolve(f.workflow.directory, 'pdf'); await fs.rename(pdf, pdf + '-original'); await symlink(external, pdf);
    await assert.rejects(f.cleanup(good), /storage_scope_unavailable/); assert.deepEqual(await fs.readdir(external), []);
    await rm(pdf); await fs.rename(pdf + '-original', pdf);
  } finally { await f.close(); }
});

test('invalid persisted JSON and an incomplete filesystem scan never yield cleanup targets', async () => {
  const f = await fixture(); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await f.upload()).paper, original = f.paper(paper.id);
    f.store.db.prepare('UPDATE workbench_papers SET payload_json=? WHERE id=?').run('{broken', paper.id);
    let preview = await f.workflow.storagePreview({}); assert.equal(preview.summary.unavailable_reason, 'storage_reference_unavailable'); assert.equal(preview.candidates.length, 0);
    f.savePaper(original);
    const run = f.seedRun(paper.id), originalRun = f.store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(run)!.payload_json as string;
    f.store.db.prepare('UPDATE workbench_runs SET payload_json=? WHERE id=?').run('{broken-run', run);
    preview = await f.workflow.storagePreview({}); assert.equal(preview.summary.unavailable_reason, 'storage_reference_unavailable'); assert.equal(preview.candidates.length, 0);
    f.store.db.prepare('UPDATE workbench_runs SET payload_json=? WHERE id=?').run(originalRun, run);
    const actual = fs.readdir;
    interceptor = mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === resolve(f.workflow.directory, 'pdf')) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
      return actual(...args);
    }); syncBuiltinESMExports();
    preview = await f.workflow.storagePreview({}); assert.equal(preview.summary.unavailable_reason, 'storage_scope_unavailable'); assert.equal(preview.candidates.length, 0);
  } finally { interceptor?.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test('a newly admitted task invalidates an earlier preview and preparation/parsing/queued work reject cleanup', async () => {
  const entered = barrier(), finish = barrier();
  const f = await fixture({ runner: { controlled: true, provider: 'fixture', model_id: 'none', execute: async () => { throw new Error('should not execute model'); } },
    parse: async () => { entered.release(); await finish.promise; throw new ContractError('isolated_parse_end'); } });
  try {
    const paper = (await f.upload()).paper, preview = await f.workflow.storagePreview({});
    await f.workflow.start(paper.id, f.workflow.scopeCatalog().default_scope); await entered.promise;
    await f.workflow.start(paper.id, f.workflow.scopeCatalog().default_scope);
    const queued = await f.workflow.start(paper.id, f.workflow.scopeCatalog().default_scope);
    assert.equal(f.store.snapshot(queued.run.run_id).state, 'queued');
    const busy = await f.app.inject({ method: 'POST', url: '/api/workbench/storage/cleanup', payload: { preview_id: preview.preview_id, version: preview.version, candidate_ids: preview.candidates.map(candidate => candidate.id) } });
    assert.equal(busy.statusCode, 409); assert.equal(busy.json().error, 'storage_busy');
    assert.equal((await f.workflow.storagePreview({})).summary.unavailable_reason, 'storage_busy');
    finish.release(); await f.workflow.waitForIdle(); await assert.rejects(f.cleanup(preview), /storage_preview_stale/);
    assert.deepEqual(await f.workflow.pdf(paper.id), bytes);
  } finally { finish.release(); await f.close(); }
});

test('pending uploads exclude cleanup, and the cleanup gate rejects upload, start, restore and paper deletion', async () => {
  const f = await fixture(); const entered = barrier(), finish = barrier(); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    await f.upload(); const preview = await f.workflow.storagePreview({}), write = fs.writeFile;
    interceptor = mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => { if (String(args[0]).endsWith('.pdf')) { entered.release(); await finish.promise; } return write(...args); }); syncBuiltinESMExports();
    const uploading = f.upload('pending'); await entered.promise; await assert.rejects(f.cleanup(preview), /storage_busy/);
    finish.release(); await uploading; interceptor.mock.restore(); syncBuiltinESMExports();
    const fresh = await f.workflow.storagePreview({}), gateEntered = barrier(), gateFinish = barrier(); const read = fs.readdir;
    interceptor = mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => { if (String(args[0]) === resolve(f.workflow.directory, 'pdf')) { gateEntered.release(); await gateFinish.promise; } return read(...args); }); syncBuiltinESMExports();
    const cleaning = f.cleanup(fresh); await gateEntered.promise;
    await assert.rejects(f.upload('blocked'), /storage_busy/);
    const paper = (await f.workflow.papers())[0]!;
    await assert.rejects(f.workflow.start(paper.id, f.workflow.scopeCatalog().default_scope), /storage_busy/);
    await assert.rejects(f.workflow.restorePdf(paper.id, bytes), /storage_busy/);
    await assert.rejects(f.workflow.deletePaper(paper.id), /storage_busy/);
    gateFinish.release(); assert.equal((await cleaning).status, 'complete');
  } finally { finish.release(); interceptor?.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test('start preparation before a run exists and the shared human/export write guard exclude cleanup', async () => {
  const entered = barrier(), finish = barrier();
  const f = await fixture({ runner: { controlled: true, provider: 'fixture', model_id: 'none', prepare: async () => { entered.release(); await finish.promise; throw new ContractError('isolated_prepare_end'); },
    execute: async () => { throw new Error('no model'); } } });
  try {
    const paper = (await f.upload()).paper, preview = await f.workflow.storagePreview({});
    const preparing = f.workflow.start(paper.id, f.workflow.scopeCatalog().default_scope).then(() => 'unexpected', error => String(error)); await entered.promise;
    assert.equal((await f.workflow.runs()).length, 0); await assert.rejects(f.cleanup(preview), /storage_busy/);
    finish.release(); assert.match(await preparing, /isolated_prepare_end/);
    const run = f.seedRun(paper.id), unrelated = (await f.upload('unrelated')).paper; assert.ok(unrelated);
    const available = await f.workflow.storagePreview({}), writeEntered = barrier(), writeFinish = barrier();
    const writing = f.workflow['withRunWrite'](run, async () => { writeEntered.release(); await writeFinish.promise; }); await writeEntered.promise;
    await assert.rejects(f.cleanup(available), /storage_busy/); writeFinish.release(); await writing;
  } finally { finish.release(); await f.close(); }
});

test('preview expiry, changed file identity, forged selection and duplicate request semantics are explicit', async () => {
  const f = await fixture();
  try {
    await f.upload(); const preview = await f.workflow.storagePreview({});
    await assert.rejects(f.cleanup(preview, ['storage-' + 'f'.repeat(32)]), /invalid_storage_selection/);
    f.advance(10 * 60_000); await assert.rejects(f.cleanup(preview), /storage_preview_expired/);
    const fresh = await f.workflow.storagePreview({}), path = resolve(f.root, f.paper(fresh.candidates[0]!.paper_ids[0]!).pdf.path);
    await writeFile(path, Buffer.from(bytes.toString() + 'changed')); await assert.rejects(f.cleanup(fresh), /storage_preview_stale/);
    const current = await f.workflow.storagePreview({}), result = await f.cleanup(current); assert.equal(result.removed_files, 1); assert.equal(result.already_executed, false);
    const repeat = await f.cleanup(current); assert.equal(repeat.already_executed, true); assert.equal(repeat.removed_bytes, result.removed_bytes);
    assert.equal((await f.workflow.papers()).length, 0);
  } finally { await f.close(); }
});

test('partial removal commits only its approved logical scope and leaves a safe explicit retry path', async () => {
  const f = await fixture(); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const paper = (await f.upload()).paper, id = 'run-' + randomUUID(), row = f.paper(paper.id);
    const ir = await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', id, 'document-ir.json')), 'IR');
    row.latest_source = { ir: { path: relative(f.root, ir), sha256: hash('IR') } }; f.savePaper(row);
    const preview = await f.workflow.storagePreview({}), unlink = nativeFs.unlinkSync;
    interceptor = mock.method(nativeFs, 'unlinkSync', (path: PathLike) => { if (String(path).endsWith('/document-ir.json')) throw Object.assign(new Error('fixture delete failed'), { code: 'EACCES' }); return unlink(path); }); syncBuiltinESMExports();
    const result = await f.cleanup(preview); assert.equal(result.status, 'partial'); assert.equal(result.removed_bytes, bytes.length); assert.equal(result.removed_files, 1);
    assert.deepEqual(result.removed_paper_ids, [paper.id]); assert.equal((await f.workflow.papers()).length, 0); await access(ir);
    assert.equal((await f.cleanup(preview)).already_executed, true);
    interceptor.mock.restore(); syncBuiltinESMExports();
    const remaining = await f.workflow.storagePreview({}); assert.equal(remaining.candidates.length, 1); assert.equal(remaining.candidates[0]!.kind, 'orphan_parse');
    assert.equal((await f.cleanup(remaining)).removed_bytes, 2); await assert.rejects(access(ir), /ENOENT/);
  } finally { interceptor?.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test('preview/receipt metadata is bounded and expired previews do not become scheduled cleanup', async () => {
  const f = await fixture();
  try {
    await f.upload();
    for (let index = 0; index < 35; index++) await f.workflow.storagePreview({});
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM workbench_storage_operations WHERE status='preview'").get()!.n, 32);
    f.advance(11 * 60_000); await f.workflow.storagePreview({});
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM workbench_storage_operations WHERE status='preview'").get()!.n, 1);
    assert.equal((await f.workflow.papers()).length, 1); assert.deepEqual(await f.workflow.pdf((await f.workflow.papers())[0]!.id), bytes);
    for (let index = 0; index < 130; index++) f.store.db.prepare('INSERT INTO workbench_storage_operations VALUES(?,?,?,?,?)').run('old-receipt-' + index, Date.now(), Date.now(), 'complete', '{}');
    await f.workflow.storagePreview({}); assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM workbench_storage_operations WHERE status='complete'").get()!.n, 128);
  } finally { await f.close(); }
});

test('interrupted cleanup is never resumed on startup and explicit retry rechecks newly introduced same-SHA references', async () => {
  const f = await fixture();
  let restarted: WorkbenchWorkflow | undefined;
  try {
    const paper = (await f.upload()).paper, preview = await f.workflow.storagePreview({});
    const row = f.store.db.prepare('SELECT payload_json FROM workbench_storage_operations WHERE id=?').get(preview.preview_id)!;
    const plan = JSON.parse(row.payload_json as string);
    plan.selection = preview.candidates.map(candidate => candidate.id).sort(); plan.removed_paper_ids = [paper.id]; plan.results = []; plan.done_files = [];
    f.store.db.prepare('DELETE FROM workbench_papers WHERE id=?').run(paper.id);
    f.store.db.prepare('UPDATE workbench_storage_operations SET status=?,payload_json=? WHERE id=?').run('executing', JSON.stringify(plan), preview.preview_id);
    await f.app.close();
    restarted = new WorkbenchWorkflow(f.store, { codeRoot: f.root, directory: f.workflow.directory, sources: false, storageNow: () => Date.now() + 48 * HOUR }); await restarted.initialize();
    const path = plan.candidates[0].files[0].path as string; await access(path);
    const newlyUploaded = (await restarted.upload(bytes, 'new-browser-draft.pdf')).paper;
    const result = await restarted.storageCleanupSelection({ preview_id: preview.preview_id, version: preview.version, candidate_ids: plan.selection });
    assert.equal(result.status, 'partial'); assert.equal(result.removed_files, 0); assert.equal(result.results[0]!.status, 'protected');
    assert.deepEqual(await restarted.pdf(newlyUploaded.id), bytes); await access(path);
  } finally { await restarted?.close(); await f.close(); }
});

test('a parent replaced after the final scan cannot redirect the descriptor-anchored unlink outside scope', async () => {
  const f = await fixture(); let interceptor: ReturnType<typeof mock.method> | undefined;
  try {
    const id = 'run-' + randomUUID(), directory = resolve(f.workflow.directory, 'runs', id);
    const path = await f.file(relative(f.root, resolve(directory, 'document-ir.json')), 'approved-file');
    const outside = await f.file('outside/document-ir.json', 'foreign-file');
    const preview = await f.workflow.storagePreview({}), open = nativeFs.openSync; let replaced = false;
    interceptor = mock.method(nativeFs, 'openSync', (...args: Parameters<typeof nativeFs.openSync>) => {
      if (!replaced && String(args[0]).endsWith('/' + id)) {
        replaced = true; nativeFs.renameSync(directory, directory + '-moved'); nativeFs.symlinkSync(dirname(outside), directory);
      }
      return open(...args);
    }); syncBuiltinESMExports();
    const result = await f.cleanup(preview); assert.equal(replaced, true); assert.equal(result.status, 'partial'); assert.equal(result.removed_files, 0);
    assert.equal(await readFile(outside, 'utf8'), 'foreign-file'); assert.equal(await readFile(resolve(directory + '-moved', 'document-ir.json'), 'utf8'), 'approved-file');
    assert.ok(!JSON.stringify(result).includes('foreign-file')); assert.ok(!JSON.stringify(result).includes(path));
  } finally { interceptor?.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test('literal slash source text is not a root reference; unknown managed paths and explicit parent references stay protected', async () => {
  const f = await fixture();
  try {
    const first = 'run-' + randomUUID(), second = 'run-' + randomUUID(), third = 'run-' + randomUUID();
    const parent = resolve(f.workflow.directory, 'runs', first);
    const byParent = await f.file(relative(f.root, resolve(parent, 'document-ir.json')), 'parent-protected');
    const byUnknownKey = await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', second, 'document-ir.json')), 'unknown-key-protected');
    const orphan = await f.file(relative(f.root, resolve(f.workflow.directory, 'runs', third, 'document-ir.json')), 'genuine-orphan');
    f.savePaper({ id: 'historical-source', title: 'Retained source', uploaded: false, pdf: { path: 'historical/retained.pdf', sha256: 'e'.repeat(64) },
      latest_source: { document: { structure: { units: [{ native_text: '/' }, { native_text: '/ ordinary source text' }] } },
        unknown_reference_key: relative(f.root, byUnknownKey), retained_context: { directory: parent } } } as { id: string });
    const preview = await f.workflow.storagePreview({}); assert.equal(preview.candidates.length, 1); assert.equal(preview.candidates[0]!.bytes, 'genuine-orphan'.length);
    assert.equal(preview.summary.protected_bytes, 'parent-protected'.length + 'unknown-key-protected'.length);
    const result = await f.cleanup(preview); assert.equal(result.removed_files, 1); await assert.rejects(access(orphan), /ENOENT/); await access(byParent); await access(byUnknownKey);
  } finally { await f.close(); }
});
