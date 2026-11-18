/** Task naming/content dedup against the isolated no-model gate on 3216. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30157', backend = 'http://127.0.0.1:3216';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14'), reportPath = join(evidence, 'report.json');
const item = Number(process.env.T1_EVIDENCE_ITEM ?? '3'), prefix = item === 3 ? 'item3' : 'item2-correction';
const runtime = JSON.parse(await readFile(join(code, 'runtime-data/agent-notes/task-identity-ui-runtime.json'), 'utf8'));
const result = { status: 'running', origin, isolated_backend: backend, controlled: true, checks: [], errors: [], blocked: [], expected_response_losses: [], screenshots: [], paid_calls: 0, production_business_writes: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', hasTouch: true });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
const requests = [], lost = new Set();
async function json(path) { const response = await fetch(backend + '/api/' + path); assert.equal(response.status, 200, path); return response.json(); }
async function save() { const report = JSON.parse(await readFile(reportPath, 'utf8')); if (item === 3) report.item3.browser = result; else report.item2.correction.browser = result; await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function check(name, work) { try { await work(); result.checks.push({ name, status: 'passed' }); console.log('PASS ' + name); } catch (error) { result.checks.push({ name, status: 'failed', error: String(error) }); throw error; } finally { await save(); } }
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (url.origin !== origin) { result.blocked.push({ method, path }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': isolated finite snapshot\n\n' });
  const upload = method === 'POST' && path.endsWith('/workbench/papers');
  const start = method === 'POST' && /\/papers\/[^/]+\/runs$/.test(path);
  const allowed = ['GET', 'HEAD'].includes(method) || upload || start || method === 'POST' && path.endsWith('/cancel');
  if (!allowed || path.includes('/exports/')) { result.blocked.push({ method, path }); return route.abort('blockedbyclient'); }
  const headers = await request.allHeaders(), body = start ? request.postDataJSON() : undefined;
  if (upload) assert.equal(headers['x-t1-title'], undefined, 'task title must never enter paper upload metadata');
  if (upload || start) requests.push({ operation: upload ? 'upload' : 'start', key: headers['x-t1-request-id'], filename: upload ? decodeURIComponent(headers['x-t1-filename']) : body.original_filename, title: body?.task_title });
  const response = await fetch(backend + path.replace(/^\/api\/t1/, '/api') + url.search, { method,
    headers: Object.fromEntries(['content-type', 'x-t1-filename', 'x-t1-request-id'].filter(key => headers[key]).map(key => [key, headers[key]])),
    ...(!['GET', 'HEAD'].includes(method) ? { body: request.postDataBuffer() } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (start && response.ok && body.task_title === '整组任务名称' && !lost.has(body.task_title)) {
    lost.add(body.task_title); result.expected_response_losses.push(body.task_title); return route.abort('failed');
  }
  return route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: bytes });
});
context.on('page', page => page.on('pageerror', error => result.errors.push(String(error))));
const page = await context.newPage();
const batch = () => page.locator('.t1-batch'), rows = () => page.locator('[data-batch-member]');
const title = () => batch().getByLabel('任务标题（可选）', { exact: true });
const pdf = (name, marker = 'A') => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% UI IDENTITY ' + marker + '\n%%EOF\n') });
async function idle() { await page.locator('.t1-batch[aria-busy="false"]').waitFor(); }
async function choose(files, count) { await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(files); await page.waitForFunction(n => document.querySelectorAll('[data-batch-member]').length === n && document.querySelector('.t1-batch')?.getAttribute('aria-busy') === 'false', count); }
async function createTab() { await page.getByRole('tab', { name: '创建任务', exact: true }).click(); await batch().waitFor(); }
async function history(query) { await page.getByRole('tab', { name: '任务与历史', exact: true }).click(); await page.getByLabel('搜索任务标题或文件名', { exact: true }).fill(query); }
async function menu(run) { await page.locator(`[data-submission-list="history"] [data-run-menu-id="${run.run_id}"]`).click(); await page.getByRole('menu', { name: '任务操作', exact: true }).waitFor(); }
try {
  assert.equal((await json('workbench/capabilities')).controlled_fixture, true);
  assert.equal((await json('workbench/runs')).runs.length, 0);
  await page.goto(origin + '/?view=newTask'); await batch().waitFor();
  assert.equal(await page.locator('.t1-reuse-paper').count(), 0);
  for (const locale of ['en', 'zh-TW', 'zh-CN']) {
    await page.locator('.t1-top-actions select').selectOption(locale);
    assert.equal(await page.locator('.t1-reuse-paper').count(), 0);
    assert.equal(await page.locator('.t1-task-title-field input').count(), 1);
    assert.doesNotMatch(await page.locator('.t1-submission-empty').first().innerText(), /existing paper|选择已有论文|選擇既有論文/);
  }
  await page.locator('.t1-new-task-panel > .t1-heading').scrollIntoViewIfNeeded();
  const desktopPath = `${prefix}-desktop.png`; await page.screenshot({ path: join(evidence, desktopPath), fullPage: true }); result.screenshots.push(desktopPath);
  await check('content_dedup_precedes_quota_and_same_name_different_content_is_retained', async () => {
    await choose([pdf('same.pdf'), pdf('same.pdf', 'B')], 2);
    assert.match(await batch().innerText(), /已分别加入/);
    await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
    await choose([...Array.from({ length: 25 }, (_, i) => pdf(i ? `alias-${i}.pdf` : 'paper-original.pdf')), pdf('second-original.pdf', 'B')], 2);
    assert.match(await batch().innerText(), /已跳过 24 份内容相同/);
    assert.equal(await batch().getByLabel('任务标题（可选）', { exact: true }).count(), 1);
    await title().fill('上传时草稿');
    await batch().getByRole('button', { name: '上传待处理 PDF（2 篇）', exact: true }).click(); await idle();
    assert.equal((await json('workbench/papers')).papers.length, 3);
    assert.equal((await json('workbench/runs')).runs.length, 0);
    assert.equal(await title().isEnabled(), true);
    await title().fill('整组任务名称');
  });
  await check('one_batch_title_freezes_independently_and_lost_response_retries_one_member', async () => {
    await batch().getByRole('button', { name: '批量开始抽取（2 篇）', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="startFailed"]').count(), 1);
    assert.equal((await json('workbench/runs')).runs.length, 2);
    assert.equal(await title().isDisabled(), true);
    await batch().getByRole('button', { name: '重试提交抽取', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 2);
    const runs = (await json('workbench/runs')).runs;
    assert.equal(runs.length, 2); assert.ok(runs.every(run => run.task_title === '整组任务名称'));
    assert.deepEqual(runs.map(run => run.original_filename).sort(), ['paper-original.pdf', 'second-original.pdf']);
    const starts = requests.filter(request => request.operation === 'start' && request.filename === 'paper-original.pdf');
    assert.equal(starts.length, 2); assert.equal(new Set(starts.map(request => request.key)).size, 1);
    const papers = (await json('workbench/papers')).papers;
    assert.ok(papers.every(paper => !paper.title.includes('整组任务') && !paper.title.includes('草稿')));
    await history('整组任务名称');
    const group = page.locator('[data-submission-list="history"] [data-submission-kind="batch"]');
    assert.equal(await group.count(), 1);
    const heading = group.locator('.t1-submission-heading'); assert.match(await heading.innerText(), /整组任务名称/);
    if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
    assert.deepEqual((await group.locator('.t1-run-select strong').allTextContents()).sort(), ['paper-original.pdf', 'second-original.pdf']);
  });
  await check('reupload_reuses_paper_but_a_new_submission_gets_its_own_task_title', async () => {
    await createTab(); await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
    await choose([pdf('alias-for-new-task.pdf')], 1); await title().fill('同文件新任务');
    await batch().getByRole('button', { name: '上传待处理 PDF（1 篇）', exact: true }).click(); await idle();
    assert.match(await rows().innerText(), /复用/); assert.equal((await json('workbench/papers')).papers.length, 3);
    await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).click(); await idle();
    const runs = (await json('workbench/runs')).runs, single = runs.find(run => run.task_title === '同文件新任务');
    assert.ok(single); assert.equal(single.original_filename, 'alias-for-new-task.pdf'); assert.equal(runs.length, 3);
    assert.equal(single.document_id, runs.find(run => run.original_filename === 'paper-original.pdf').document_id);
  });
  await check('task_navigation_search_picker_menu_cancel_and_delete_confirmation_use_task_identity_on_desktop_and_mobile', async () => {
    const run = (await json('workbench/runs')).runs.find(run => run.task_title === '同文件新任务');
    await batch().getByRole('button', { name: '查看任务／结果', exact: true }).click();
    assert.equal(await page.locator('.t1-workspace-bar > span').innerText(), '同文件新任务');
    await page.locator('.t1-task-picker > summary').click(); assert.match(await page.getByLabel('任务', { exact: true }).innerText(), /整组任务名称/); assert.match(await page.getByLabel('任务', { exact: true }).innerText(), /同文件新任务/);
    await history('同文件新任务'); assert.equal(await page.locator('[data-submission-list="history"] [data-run-row]').count(), 1);
    await menu(run); assert.match(await page.getByRole('menu', { name: '任务操作', exact: true }).innerText(), /同文件新任务/);
    assert.equal(await page.getByRole('menuitem', { name: '再次抽取', exact: true }).count(), 0);
    assert.equal(await page.getByRole('menuitem', { name: '查看这次抽取', exact: true }).count(), 1);
    assert.equal(await page.getByRole('menuitem', { name: '删除这次抽取记录', exact: true }).count(), 1);
    await page.getByRole('menuitem', { name: '取消此任务', exact: true }).click(); await page.locator('.t1-task-toast[aria-busy="false"]').waitFor(); assert.match(await page.locator('.t1-task-toast').innerText(), /同文件新任务/);
    await page.locator('.t1-task-toast .t1-refresh-dismiss').click();
    await menu(run); await page.getByRole('menuitem', { name: '删除这次抽取记录', exact: true }).click();
    const deletion = page.locator('.t1-delete-dialog[open]'); await deletion.waitFor(); assert.match(await deletion.locator('.t1-delete-target').innerText(), /同文件新任务/); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 }); await createTab(); await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
    assert.equal(await page.locator('.t1-reuse-paper').count(), 0);
    const field = title(); assert.equal(await field.isEnabled(), true); await field.fill('手机任务草稿');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await history('同文件新任务');
    await page.locator(`[data-submission-list="history"] [data-run-menu-id="${run.run_id}"]`).tap();
    const mobileMenu = page.getByRole('dialog', { name: '任务操作', exact: true }); await mobileMenu.waitFor();
    assert.equal(await page.getByRole('menuitem', { name: '再次抽取', exact: true }).count(), 0);
    assert.equal(await page.getByRole('menuitem', { name: '查看这次抽取', exact: true }).count(), 1);
    const path = `${prefix}-mobile.png`; await page.screenshot({ path: join(evidence, path), fullPage: true }); result.screenshots.push(path);
    await page.keyboard.press('Escape');
    assert.equal((await json('workbench/runs')).runs.length, 3); assert.equal((await json('workbench/papers')).papers.length, 3);
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.status = 'passed'; result.request_counts = { uploads: requests.filter(request => request.operation === 'upload').length, starts: requests.filter(request => request.operation === 'start').length };
} catch (error) { result.status = 'failed'; result.failure = error.stack ?? String(error); throw error; }
finally { await save(); await context.unrouteAll({ behavior: 'wait' }); await browser.close(); }
