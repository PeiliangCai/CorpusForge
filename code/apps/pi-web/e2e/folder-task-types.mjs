/** Real directory inputs + isolated controlled backend only; production receives no mutations. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30152', backend = 'http://127.0.0.1:3212';
const evidence = join(code, 'docs/acceptance/folder-task-types-2026-11-13'); await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(join(code, 'runtime-data/folder-input-'));
const report = { origin, backend, BUILD_ID: (await readFile(join(code, 'apps/pi-web/build/folder-task-types-20261113/BUILD_ID'), 'utf8')).trim(),
  controlled: true, checks: [], errors: [], blocked: [], paid_model_calls: 0, production_write_requests: 0, max_layout_delta_px: 0, max_center_delta_px: 0 };
async function disk(path, content = '%PDF-1.4\n% LOCAL DIRECTORY ENGINEERING STUB\n%%EOF\n') { const target = join(fixture, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); return target; }
await disk('mixed/a/same.pdf'); await disk('mixed/b/same.PDF'); await disk('mixed/nested/deep/c.PdF'); await disk('mixed/empty.pdf', '');
await disk('mixed/readme.txt', 'must never upload'); await disk('mixed/nested/image.png', 'must never upload');
await disk('no-pdfs/notes.txt', 'not pdf'); await mkdir(join(fixture, 'empty'));
await disk('one/only.PDF'); await disk('twins/left/duplicate.pdf'); await disk('twins/right/duplicate.pdf');
for (let index = 0; index < 21; index++) await disk(`over-limit/${index}.pdf`);
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin !== expected) return; localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); }, origin);
const requests = [], papers = new Map(); let failUpload = true, loseStart = true, readGate = null, failReads = false;
const json = async path => { const response = await fetch(backend + '/api/' + path); assert.equal(response.status, 200, path); return response.json(); };
async function cancelAll() { for (const run of (await json('workbench/runs')).runs) if (run.fixture && !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.state)) {
  assert.equal((await fetch(backend + '/api/workbench/runs/' + run.run_id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
} }
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (url.origin !== origin) { report.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': isolated snapshot\n\n' });
  if (!['GET', 'HEAD'].includes(method) && !(method === 'POST' && /\/workbench\/papers(?:\/[^/]+\/runs)?$/.test(path))) {
    report.blocked.push({ path, method }); return route.abort('blockedbyclient');
  }
  if (path.includes('/exports/')) { report.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
  const headers = await request.allHeaders(), upload = method === 'POST' && path.endsWith('/workbench/papers'), start = method === 'POST' && /\/papers\/[^/]+\/runs$/.test(path);
  const name = upload ? decodeURIComponent(headers['x-t1-filename']) : start ? papers.get(path.split('/').at(-2))?.name : '';
  if (upload || start) requests.push({ operation: upload ? 'upload' : 'start', name, key: headers['x-t1-request-id'], ...(upload ? { title: headers['x-t1-title'] ? decodeURIComponent(headers['x-t1-title']) : '' } : request.postDataJSON()) });
  if (upload && name === 'same.PDF' && failUpload) { failUpload = false; return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"t1_backend_unavailable"}' }); }
  if (failReads && /^\/api\/t1\/workbench\/runs\//.test(path)) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"t1_backend_unavailable"}' });
  const response = await fetch(backend + path.replace(/^\/api\/t1/, '/api') + url.search, { method,
    headers: Object.fromEntries(['content-type', 'x-t1-filename', 'x-t1-title', 'x-t1-request-id'].filter(key => headers[key]).map(key => [key, headers[key]])),
    ...(!['GET', 'HEAD'].includes(method) ? { body: request.postDataBuffer() } : {}) });
  const body = Buffer.from(await response.arrayBuffer());
  if (upload && response.ok) papers.set(JSON.parse(body.toString()).paper.id, { name, title: headers['x-t1-title'] ? decodeURIComponent(headers['x-t1-title']) : name });
  if (start && name === 'same.pdf' && loseStart) { loseStart = false; return route.abort('failed'); }
  if (readGate && method === 'GET') await readGate.promise;
  return route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body });
});
context.on('page', page => page.on('pageerror', error => report.errors.push(String(error))));
const page = await context.newPage();
const batch = () => page.locator('.t1-batch'), rows = () => page.locator('[data-batch-member]');
const fileInput = () => page.getByLabel('选择 PDF', { exact: true }), folderInput = () => page.locator('input[webkitdirectory]');
const member = path => rows().filter({ has: page.locator('.t1-batch-file strong', { hasText: path }) });
const pdf = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% LOCAL ' + name + '\n%%EOF\n') });
async function idle() { await page.locator('.t1-batch[aria-busy="false"]').waitFor(); }
async function clear() { await batch().getByRole('button', { name: '清空本次选择', exact: true }).click(); }
async function newTask() { await page.getByRole('tab', { name: '创建任务', exact: true }).click(); await batch().waitFor(); }
async function check(name, work) { await work(); report.checks.push(name); await writeFile(join(code, 'runtime-data/agent-notes/folder-task-types-browser.json'), JSON.stringify(report, null, 2) + '\n'); }
let restarted;
try {
  assert.equal((await json('workbench/capabilities')).controlled_fixture, true); await cancelAll();
  await page.goto(origin + '/?view=newTask'); await batch().waitFor();
  assert.equal((await context.request.get(origin + '/_next/static/' + report.BUILD_ID + '/_buildManifest.js')).status(), 200);
  await check('two_clear_picker_entries_and_unsupported_folder_fallback', async () => {
    assert.equal(await batch().getByRole('button', { name: '选择文件', exact: true }).count(), 1); assert.equal(await batch().getByRole('button', { name: '选择文件夹', exact: true }).count(), 1);
    await folderInput().evaluate(input => { const prototype = Object.getPrototypeOf(input); Object.defineProperty(window, '__folderDescriptor', { value: Object.getOwnPropertyDescriptor(prototype, 'webkitdirectory'), configurable: true }); delete prototype.webkitdirectory; });
    await batch().getByRole('button', { name: '选择文件夹', exact: true }).click(); assert.ok((await batch().innerText()).includes('此浏览器不支持选择文件夹'));
    await folderInput().evaluate(input => { Object.defineProperty(Object.getPrototypeOf(input), 'webkitdirectory', window.__folderDescriptor); delete window.__folderDescriptor; });
    const chooser = page.waitForEvent('filechooser'); await batch().getByRole('button', { name: '选择文件夹', exact: true }).click();
    await (await chooser).setFiles(join(fixture, 'one')); assert.equal(await rows().count(), 1);
  });
  await check('folder_with_one_pdf_is_single_and_keeps_metadata_after_upload_and_start', async () => {
    assert.equal(await member('one/only.PDF').locator('[data-task-kind="single"]').count(), 1);
    await batch().getByRole('button', { name: '上传待处理 PDF（1 篇）', exact: true }).click(); await idle();
    await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).click(); await idle();
    const run = (await json('workbench/runs')).runs.find(run => run.fixture && papers.get(run.document_id)?.name === 'only.PDF');
    assert.deepEqual(run.submission, { kind: 'single' }); report.single_run = run.run_id;
    assert.equal((await json('workbench/papers')).papers.find(paper => paper.id === run.document_id).title, 'one/only.PDF');
    await cancelAll(); await clear();
  });
  await check('real_directory_recurses_filters_case_insensitively_and_preserves_same_basename_paths', async () => {
    await folderInput().setInputFiles(join(fixture, 'mixed')); assert.equal(await rows().count(), 4);
    assert.equal(await page.locator('[data-upload-state="invalid"]').count(), 1);
    assert.ok((await batch().innerText()).includes('识别到 4 个 PDF，已跳过 2 个其他文件'));
    for (const path of ['mixed/a/same.pdf', 'mixed/b/same.PDF', 'mixed/nested/deep/c.PdF']) {
      assert.equal(await member(path).count(), 1); assert.equal(await member(path).locator('input').inputValue(), path); assert.equal(await member(path).locator('[data-task-kind="batch"]').count(), 1);
    }
    assert.equal(await member('readme.txt').count(), 0); assert.equal(await member('image.png').count(), 0);
    await page.screenshot({ path: join(evidence, 'directory-desktop.png'), fullPage: true });
  });
  await check('empty_and_oversized_directory_additions_are_explicit_and_leave_existing_selection_untouched', async () => {
    const before = await rows().evaluateAll(elements => elements.map(element => element.getAttribute('data-batch-member')));
    for (const directory of ['no-pdfs', 'empty']) { await folderInput().setInputFiles(join(fixture, directory)); assert.ok((await batch().innerText()).includes('没有 PDF')); assert.deepEqual(await rows().evaluateAll(elements => elements.map(element => element.getAttribute('data-batch-member'))), before); }
    await folderInput().setInputFiles(join(fixture, 'over-limit')); assert.ok((await batch().innerText()).includes('本次选择 21 个文件，当前还可加入 16 篇'));
    assert.deepEqual(await rows().evaluateAll(elements => elements.map(element => element.getAttribute('data-batch-member'))), before);
  });
  await check('failed_upload_is_counted_at_first_start_and_start_response_loss_keeps_batch_identity_on_single_item_retries', async () => {
    await batch().getByRole('button', { name: '上传待处理 PDF（3 篇）', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="uploadFailed"]').count(), 1); assert.equal(await page.locator('[data-upload-state="uploaded"]').count(), 2);
    await batch().getByRole('button', { name: '批量开始抽取（2 篇）', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="startFailed"]').count(), 1); assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 1);
    const admitted = requests.filter(request => request.operation === 'start' && ['same.pdf', 'c.PdF'].includes(request.name));
    assert.ok(admitted.every(request => request.submission.kind === 'batch')); const batchId = admitted[0].submission.batch_id;
    assert.ok(admitted.every(request => request.submission.batch_id === batchId)); report.batch_id = batchId;
    const before = (await json('workbench/runs')).runs.length;
    await page.getByLabel('癌种', { exact: true }).selectOption('selected');
    await member('mixed/a/same.pdf').getByRole('button', { name: '重试提交抽取', exact: true }).click(); await idle();
    assert.equal((await json('workbench/runs')).runs.length, before, 'response-loss retry does not admit a second run');
    await member('mixed/b/same.PDF').getByRole('button', { name: '重试上传', exact: true }).click(); await idle();
    await batch().getByRole('button', { name: '批量开始抽取（1 篇）', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 3);
    for (const name of ['same.pdf', 'same.PDF', 'c.PdF']) { const calls = requests.filter(request => request.operation === 'start' && request.name === name); assert.equal(new Set(calls.map(request => request.key)).size, 1); for (const call of calls) { assert.equal(call.submission.kind, 'batch'); assert.equal(call.submission.batch_id, batchId); assert.equal(call.scope.cancers.mode, 'all'); } }
    const runs = (await json('workbench/runs')).runs.filter(run => run.submission?.batch_id === batchId); assert.equal(runs.length, 3); assert.equal(runs.filter(run => run.state === 'parsing').length, 2); assert.equal(runs.filter(run => run.state === 'queued').length, 1);
    report.batch_runs = runs.map(run => run.run_id);
    assert.deepEqual(new Set(runs.map(run => papers.get(run.document_id).title)), new Set(['mixed/a/same.pdf', 'mixed/b/same.PDF', 'mixed/nested/deep/c.PdF']));
    assert.equal(requests.filter(request => request.operation === 'upload' && ['empty.pdf', 'readme.txt', 'image.png'].includes(request.name)).length, 0);
  });
  await check('multiple_file_picker_remains_available_and_invalid_members_do_not_make_a_single_task_batch', async () => {
    await cancelAll(); await clear(); await page.getByLabel('癌种', { exact: true }).selectOption('all');
    await fileInput().setInputFiles(Array.from({ length: 21 }, (_, index) => pdf(`limit-${index}.pdf`))); assert.equal(await rows().count(), 0); assert.ok((await batch().innerText()).includes('本次未加入'));
    await fileInput().setInputFiles([pdf('multi-a.pdf'), pdf('multi-b.pdf')]); assert.equal(await rows().count(), 2); assert.equal(await batch().locator('.t1-batch-counts [data-task-kind="batch"]').count(), 1);
    await clear(); await fileInput().setInputFiles([pdf('single-with-invalid.pdf'), { name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') }]);
    assert.equal(await batch().locator('.t1-batch-counts [data-task-kind="single"]').count(), 1);
    await batch().getByRole('button', { name: '上传待处理 PDF（1 篇）', exact: true }).click(); await idle(); await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).click(); await idle();
    assert.equal((await json('workbench/runs')).runs.find(run => papers.get(run.document_id)?.name === 'single-with-invalid.pdf').submission.kind, 'single');
    await cancelAll(); await clear();
  });
  await check('identical_basenames_in_different_subfolders_remain_distinct_after_upload_and_start', async () => {
    await folderInput().setInputFiles(join(fixture, 'twins')); assert.equal(await rows().count(), 2);
    for (const path of ['twins/left/duplicate.pdf', 'twins/right/duplicate.pdf']) assert.equal(await member(path).count(), 1);
    await batch().getByRole('button', { name: '上传待处理 PDF（2 篇）', exact: true }).click(); await idle();
    await batch().getByRole('button', { name: '批量开始抽取（2 篇）', exact: true }).click(); await idle();
    const runs = (await json('workbench/runs')).runs.filter(run => papers.get(run.document_id)?.name === 'duplicate.pdf'); assert.equal(runs.length, 2);
    assert.equal(new Set(runs.map(run => run.document_id)).size, 2); assert.equal(new Set(runs.map(run => run.submission.batch_id)).size, 1);
    assert.deepEqual(new Set(runs.map(run => papers.get(run.document_id).title)), new Set(['twins/left/duplicate.pdf', 'twins/right/duplicate.pdf']));
    await cancelAll(); await clear();
  });
  await check('dedicated_paper_start_always_records_single', async () => {
    const paper = [...papers.keys()][0]; await page.getByLabel('本次任务论文', { exact: true }).selectOption(paper);
    await page.getByRole('button', { name: '开始抽取', exact: true }).click(); await page.locator('.t1-task-picker [data-task-kind="single"]').waitFor();
    const run = (await json('workbench/runs')).runs.filter(run => run.document_id === paper)[0]; assert.deepEqual(run.submission, { kind: 'single' });
    await cancelAll();
  });
  await check('task_history_and_selected_result_show_persisted_types_and_legacy_is_unrecorded', async () => {
    await page.getByRole('tab', { name: '任务与历史', exact: true }).click();
    assert.ok(await page.locator('.t1-task-row [data-task-kind="batch"]').count() >= 3); assert.ok(await page.locator('.t1-task-row [data-task-kind="single"]').count() >= 2); assert.ok(await page.locator('.t1-task-row [data-task-kind="unrecorded"]').count() > 0);
    await page.screenshot({ path: join(evidence, 'task-history-desktop.png'), fullPage: true });
    const batchRun = report.batch_runs[0], run = (await json('workbench/runs')).runs.find(run => run.run_id === batchRun);
    await page.goto(origin + '/?' + new URLSearchParams({ paper: run.document_id, run: batchRun, view: 'records' })); await page.locator('.t1-task-picker [data-task-kind="batch"]').waitFor();
    await page.reload(); await page.locator('.t1-task-picker [data-task-kind="batch"]').waitFor();
    assert.equal(await page.locator('.t1-task-picker select option:checked').textContent().then(value => value.startsWith('批量')), true);
    await page.screenshot({ path: join(evidence, 'batch-result-desktop.png') });
  });
  await check('metadata_survives_real_fixture_process_restart_without_new_admission', async () => {
    const before = (await json('workbench/runs')).runs.map(run => [run.run_id, run.submission ?? null]);
    const runtime = JSON.parse(await readFile(join(code, 'runtime-data/agent-notes/folder-task-types-fixture.json'), 'utf8')); process.kill(runtime.pid, 'SIGTERM');
    for (let index = 0; index < 100; index++) { try { await fetch(backend + '/health'); await new Promise(resolve => setTimeout(resolve, 25)); } catch { break; } }
    restarted = spawn(process.execPath, ['--import', 'tsx', 'apps/server/test/folder-task-types-fixture.ts'], { cwd: code, stdio: 'ignore' });
    for (let index = 0; index < 200; index++) { try { if ((await fetch(backend + '/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.deepEqual((await json('workbench/runs')).runs.map(run => [run.run_id, run.submission ?? null]), before);
    for (const id of report.batch_runs) assert.equal((await json('workbench/runs/' + id)).run.submission.batch_id, report.batch_id);
    await page.reload(); await page.locator('.t1-task-picker [data-task-kind="batch"]').waitFor();
  });
  await check('mobile_task_and_directory_controls_fit_and_refresh_keeps_one_centered_arrow_without_layout_shift', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.t1-task-picker [data-task-kind="batch"]').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: join(evidence, 'batch-result-mobile.png') });
    await newTask(); await folderInput().setInputFiles(join(fixture, 'one')); await page.evaluate(() => document.fonts.ready);
    assert.equal(await batch().getByRole('button', { name: '选择文件夹', exact: true }).isVisible(), true); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const geometry = () => page.evaluate(() => Object.fromEntries(['.t1-body', '.t1-content-region', '.t1-heading', '.t1-file-choices', '.t1-batch-members'].map(selector => { const box = document.querySelector(selector).getBoundingClientRect(); return [selector, { x: box.x, y: box.y, width: box.width, height: box.height }]; })));
    const before = await geometry(); let release; readGate = { promise: new Promise(resolve => { release = resolve; }) };
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-refresh-spinner').waitFor();
    assert.equal(await page.locator('.t1-refresh-spinner').count(), 1); const after = await geometry();
    for (const selector of Object.keys(before)) for (const coordinate of Object.keys(before[selector])) { const delta = Math.abs(before[selector][coordinate] - after[selector][coordinate]); report.max_layout_delta_px = Math.max(report.max_layout_delta_px, delta); assert.ok(delta < .6, selector + coordinate + delta); }
    const icon = await page.locator('.t1-refresh-spinner').boundingBox(), body = await page.locator('.t1-body').boundingBox(); report.max_center_delta_px = Math.max(Math.abs(icon.x + icon.width / 2 - body.x - body.width / 2), Math.abs(icon.y + icon.height / 2 - body.y - body.height / 2)); assert.ok(report.max_center_delta_px < .6);
    assert.equal(await page.locator('.t1-refresh-spinner').evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.screenshot({ path: join(evidence, 'directory-mobile-refresh.png') }); readGate = null; release(); await page.locator('.t1-refresh-toast[data-failed="false"]').waitFor();
    assert.equal(await member('one/only.PDF').count(), 1);
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); await page.screenshot({ path: join(code, 'runtime-data/agent-notes/folder-task-types-browser-failure.png'), fullPage: true }); throw error; }
finally {
  readGate = null; await writeFile(join(code, 'runtime-data/agent-notes/folder-task-types-browser.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close(); await rm(fixture, { recursive: true, force: true });
  if (restarted) { restarted.kill('SIGTERM'); await new Promise(resolve => restarted.once('exit', resolve)); }
}
