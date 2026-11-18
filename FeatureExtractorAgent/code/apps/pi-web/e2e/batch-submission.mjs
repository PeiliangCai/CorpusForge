/** Production frontend against an isolated controlled gate on 3211. No real model or production mutations. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30152', backend = 'http://127.0.0.1:3211';
const evidence = resolve(code, process.env.T1_EVIDENCE_DIR ?? 'docs/acceptance/batch-submission-2026-11-13'); await mkdir(evidence, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const report = { origin, backend, BUILD_ID: (await readFile(join(code, 'apps/pi-web', process.env.T1_NEXT_DIST_DIR ?? 'build/folder-task-types-20261113', 'BUILD_ID'), 'utf8')).trim(), controlled: true, checks: [], errors: [], blocked: [], paid_model_calls: 0, production_write_requests: 0, expected_failures: [] };
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin !== expected) return; try { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } catch {} }, origin);
const requests = [], filenames = new Map(), lostUpload = new Set(), failedUpload = new Set(), lostStart = new Set(), failedStart = new Set();
let delayUploads = false, refreshDelay = false, holdResult = false, releaseResult;
const json = async path => { const response = await fetch(backend + '/api/' + path); assert.equal(response.status, 200, path); return response.json(); };
async function cancelAll() {
  for (const run of (await json('workbench/runs')).runs) if (run.fixture && !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.state)) {
    assert.equal((await fetch(backend + '/api/workbench/runs/' + run.run_id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
  }
}
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  if (url.origin !== origin) { report.blocked.push({ method: request.method(), path }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': controlled snapshot\n\n' });
  const method = request.method(), headers = await request.allHeaders();
  const allowed = ['GET', 'HEAD'].includes(method) || method === 'POST' && (/\/workbench\/papers(?:\/[^/]+\/runs)?$/.test(path) || /\/retention$/.test(path));
  if (!allowed || path.includes('/exports/')) { report.blocked.push({ method, path }); return route.abort('blockedbyclient'); }
  const upload = method === 'POST' && path.endsWith('/workbench/papers');
  const start = method === 'POST' && /\/papers\/[^/]+\/runs$/.test(path);
  const name = upload ? decodeURIComponent(headers['x-t1-filename']) : start ? filenames.get(path.split('/').at(-2)) : '';
  if (upload || start) { assert.match(headers['x-t1-request-id'], /^[A-Za-z0-9_-]{8,120}$/); requests.push({ operation: upload ? 'upload' : 'start', name, key: headers['x-t1-request-id'], ...(start ? { scope: request.postDataJSON().scope } : {}) }); }
  if (upload && name === 'b.pdf' && !failedUpload.has(name)) { failedUpload.add(name); report.expected_failures.push('b upload before commit'); return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"t1_backend_unavailable"}' }); }
  if (start && name === 'b.pdf' && !failedStart.has(name)) { failedStart.add(name); report.expected_failures.push('b start before commit'); return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"t1_backend_unavailable"}' }); }
  const response = await fetch(backend + path.replace(/^\/api\/t1/, '/api') + url.search, { method,
    headers: Object.fromEntries(['content-type', 'x-t1-filename', 'x-t1-title', 'x-t1-request-id'].filter(key => headers[key]).map(key => [key, headers[key]])),
    ...(!['GET', 'HEAD'].includes(method) ? { body: request.postDataBuffer() } : {}) });
  const body = Buffer.from(await response.arrayBuffer());
  if (upload && response.ok) filenames.set(JSON.parse(body.toString()).paper.id, name);
  if (upload && name === 'a.pdf' && !lostUpload.has(name)) { lostUpload.add(name); report.expected_failures.push('a upload committed, response lost'); return route.abort('failed'); }
  if (start && name === 'c.pdf' && !lostStart.has(name)) { lostStart.add(name); report.expected_failures.push('c start committed, response lost'); return route.abort('failed'); }
  if (delayUploads && upload || refreshDelay && method === 'GET') await new Promise(resolve => setTimeout(resolve, 250));
  if (holdResult && /^\/api\/t1\/workbench\/runs\//.test(path)) { holdResult = false; await new Promise(resolve => { releaseResult = resolve; }); }
  return route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body });
});
context.on('page', page => page.on('pageerror', error => report.errors.push(String(error))));
const page = await context.newPage();
const pdf = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% ENGINEERING ' + name + '\n%%EOF\n') });
const batch = () => page.locator('.t1-batch'), rows = () => page.locator('[data-batch-member]');
const member = name => rows().filter({ has: page.locator('.t1-batch-file strong', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
async function idle() { await page.locator('.t1-batch[aria-busy="false"]').waitFor(); }
async function newTask() { await page.getByRole('tab', { name: '创建任务', exact: true }).click(); await batch().waitFor(); }
async function check(name, work) { try { await work(); report.checks.push({ name, status: 'passed' }); } catch (error) { report.checks.push({ name, status: 'failed', error: error.stack ?? String(error) }); throw error; } finally { await writeFile(join(evidence, 'batch-browser.json'), JSON.stringify(report, null, 2) + '\n'); } }

try {
  assert.equal((await json('workbench/capabilities')).controlled_fixture, true);
  await cancelAll(); await page.goto(origin + '/?view=newTask'); await batch().waitFor();
  const initialPapers = (await json('workbench/papers')).papers.length;
  const initialFixtureRuns = (await json('workbench/runs')).runs.filter(run => run.fixture).length;
  await check('single_PDF_upload_and_explicit_start_remain_supported', async () => {
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(pdf('single.pdf'));
    await batch().getByRole('button', { name: /上传待处理 PDF/ }).click(); await idle();
    assert.equal((await json('workbench/papers')).papers.length, initialPapers + 1);
    assert.equal((await json('workbench/runs')).runs.filter(run => run.fixture).length, initialFixtureRuns);
    await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).click(); await idle();
    assert.equal(await member('single.pdf').getAttribute('data-upload-state'), 'submitted');
    await member('single.pdf').getByRole('button', { name: '查看任务／结果' }).click();
    await page.locator('.t1-task-progress').waitFor(); await newTask();
    assert.equal(await member('single.pdf').getAttribute('data-upload-state'), 'submitted');
    await cancelAll(); await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
  });
  await check('same_name_metadata_does_not_drop_distinct_files_and_twenty_file_limit_is_visible', async () => {
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles([{ ...pdf('same.pdf'), buffer: Buffer.from('%PDF-1.4\nAAAA\n%%EOF\n') }, { ...pdf('same.pdf'), buffer: Buffer.from('%PDF-1.4\nBBBB\n%%EOF\n') }]);
    assert.equal(await rows().count(), 2); assert.ok((await batch().innerText()).includes('已分别加入'));
    await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(Array.from({ length: 21 }, (_, index) => pdf(`limit-${index}.pdf`)));
    assert.equal(await rows().count(), 0); assert.ok((await batch().innerText()).includes('本次未加入'));
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(Array.from({ length: 20 }, (_, index) => pdf(`limit-${index}.pdf`)));
    assert.equal(await rows().count(), 20);
    await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
  });
  await check('mixed_valid_invalid_empty_and_oversize_continue_with_valid_files_and_keep_batch_across_tabs', async () => {
    // Playwright limits in-memory input payloads to 50 MB. Construct the oversized
    // client File locally so this boundary test never buffers it over the protocol.
    await page.getByLabel('选择 PDF', { exact: true }).evaluate(input => {
      const data = new DataTransfer();
      for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) data.items.add(new File(['%PDF-1.4\n% ENGINEERING ' + name + '\n%%EOF\n'], name, { type: 'application/pdf' }));
      data.items.add(new File(['x'], 'bad.txt', { type: 'text/plain' })); data.items.add(new File([], 'empty.pdf', { type: 'application/pdf' }));
      data.items.add(new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'huge.pdf', { type: 'application/pdf' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await rows().count(), 6); assert.equal(await page.locator('[data-upload-state="invalid"]').count(), 3);
    delayUploads = true;
    await batch().getByRole('button', { name: '上传待处理 PDF（3 篇）', exact: true }).click();
    await page.getByRole('tab', { name: '任务与历史', exact: true }).click(); await newTask(); await idle(); delayUploads = false;
    assert.equal(await page.locator('[data-upload-state="uploadFailed"]').count(), 2); assert.equal(await page.locator('[data-upload-state="uploaded"]').count(), 1);
    assert.equal((await json('workbench/papers')).papers.length, initialPapers + 3); // single + committed a/c
    assert.equal(requests.filter(request => request.operation === 'upload' && ['bad.txt', 'empty.pdf', 'huge.pdf'].includes(request.name)).length, 0);
    await page.screenshot({ path: join(evidence, 'batch-partial-upload-desktop.png'), fullPage: true });
  });
  await check('retry_only_failed_uploads_reuses_keys_and_preserves_successful_members', async () => {
    const cKey = requests.find(request => request.operation === 'upload' && request.name === 'c.pdf').key;
    await member('a.pdf').getByRole('button', { name: '重试上传', exact: true }).click(); await idle();
    await member('b.pdf').getByRole('button', { name: '重试上传', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="uploaded"]').count(), 3);
    assert.equal((await json('workbench/papers')).papers.length, initialPapers + 4);
    assert.equal(requests.filter(request => request.key === cKey).length, 1);
    for (const name of ['a.pdf', 'b.pdf']) assert.equal(new Set(requests.filter(request => request.operation === 'upload' && request.name === name).map(request => request.key)).size, 1);
    for (const name of ['bad.txt', 'empty.pdf', 'huge.pdf']) await member(name).getByRole('button', { name: '移出本批' }).click();
  });
  await check('invalid_scope_blocks_both_start_paths_then_batch_uses_one_saved_scope_without_widening', async () => {
    await page.getByLabel('癌种', { exact: true }).selectOption('selected');
    assert.equal(await batch().getByRole('button', { name: '批量开始抽取（3 篇）', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '开始抽取', exact: true }).isDisabled(), true);
    await page.getByLabel('癌种', { exact: true }).selectOption('all');
    const before = (await json('workbench/runs')).runs.length;
    await batch().getByRole('button', { name: '批量开始抽取（3 篇）', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 1); assert.equal(await page.locator('[data-upload-state="startFailed"]').count(), 2);
    assert.equal((await json('workbench/runs')).runs.length, before + 2);
    await page.getByLabel('癌种', { exact: true }).selectOption('selected');
    assert.ok((await page.locator('.t1-batch-scope').innerText()).includes('更改上方范围不会改动本批'));
    await member('b.pdf').getByRole('button', { name: '重试提交抽取' }).click(); await idle();
    await member('c.pdf').getByRole('button', { name: '重试提交抽取' }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 3); assert.equal((await json('workbench/runs')).runs.length, before + 3);
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
      const starts = requests.filter(request => request.operation === 'start' && request.name === name); assert.equal(new Set(starts.map(request => request.key)).size, 1);
      for (const start of starts) assert.equal(start.scope.cancers.mode, 'all');
    }
    const live = (await json('workbench/runs')).runs.filter(run => run.fixture && !['cancelled', 'failed'].includes(run.state));
    assert.equal(live.filter(run => run.state === 'parsing').length, 2); assert.equal(live.filter(run => run.state === 'queued').length, 1);
    assert.equal(new Set(live.map(run => run.document_id)).size, 3);
    await page.screenshot({ path: join(evidence, 'batch-submitted-desktop.png'), fullPage: true });
  });
  await check('mobile_batch_status_and_view_task_preserve_the_batch', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await member('c.pdf').getByRole('button', { name: '查看任务／结果' }).click(); await newTask();
    assert.equal(await rows().count(), 3); assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(evidence, 'batch-mobile.png'), fullPage: true });
    await cancelAll();
  });
  await check('existing_continuous_source_and_keep_exclude_restore_survive_refresh', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const run = (await json('workbench/runs')).runs.find(run => run.document_id === 'L07' && run.candidate_count === 26);
    const detail = await json('workbench/runs/' + encodeURIComponent(run.run_id)), record = detail.output.records.find(record => record.fragments.length >= 4 && record.passages.length === 1);
    await page.goto(origin + '/?' + new URLSearchParams({ paper: run.document_id, run: run.run_id, record: record.id, view: 'records' })); await page.locator('.t1-retention').waitFor();
    assert.deepEqual(await page.locator('.t1-quote-frame [data-fragment-index]').allTextContents(), record.fragments.map(fragment => fragment.exact_quote));
    await page.getByRole('button', { name: '排除此条', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-retention-count="excluded"]')?.textContent === '1');
    await page.locator('[data-retention-view="excluded"]').click(); await page.getByRole('button', { name: '恢复保留', exact: true }).waitFor();
    const selected = await page.locator('.t1-evidence-card').getAttribute('data-record-id');
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-refresh-toast[data-failed="false"]').waitFor();
    assert.equal(await page.locator('[data-retention-view="excluded"]').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-record-id'), selected);
    await page.getByRole('button', { name: '恢复保留', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-retention-count="excluded"]')?.textContent === '0');
  });
  await check('selection_change_during_refresh_waits_for_new_result_and_old_read_cannot_overwrite', async () => {
    const runs = (await json('workbench/runs')).runs.filter(run => run.document_id === 'L01' && !run.fixture);
    assert.ok(runs.length > 1);
    await page.goto(origin + '/?' + new URLSearchParams({ paper: runs[0].document_id, run: runs[0].run_id, view: 'records' })); await page.locator('.t1-retention').waitFor();
    refreshDelay = true; holdResult = true;
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.t1-top-actions button[aria-busy="true"]'));
    for (let i = 0; i < 100 && !releaseResult; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseResult);
    const current = new URL(page.url()).searchParams.get('run'), next = runs.find(run => run.run_id !== current);
    await page.locator('.t1-task-picker > summary').click(); await page.getByLabel('任务', { exact: true }).selectOption('run:' + next.run_id);
    releaseResult(); refreshDelay = false;
    await page.locator('.t1-refresh-toast[data-failed="false"]').waitFor();
    assert.equal(await page.getByLabel('任务', { exact: true }).inputValue(), 'run:' + next.run_id);
    assert.equal(new URL(page.url()).searchParams.get('run'), next.run_id);
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); throw error; }
finally { releaseResult?.(); await cancelAll(); await writeFile(join(evidence, 'batch-browser.json'), JSON.stringify(report, null, 2) + '\n'); await browser.close(); }
