/** Final built Next gateway -> isolated workflow. No real task operations or providers. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30155', fixture = 'http://127.0.0.1:3215';
const evidence = join(code, 'docs/acceptance/task-delete-entry-2026-11-13'), dist = 'apps/pi-web/build/task-records-validated-20261113';
const runtime = JSON.parse(await readFile(join(code, 'runtime-data/task-records-fixture-20261113/runtime.json'), 'utf8')), ids = runtime.ids;
const result = { status: 'in_progress', origin, fixture, dist, BUILD_ID: (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim(), checks: [], errors: [], blocked: [], mutations: [], screenshots: [], dialog_positions: [], production_write_requests: 0, paid_model_calls: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', hasTouch: true, acceptDownloads: true });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
let failDelete = null, stale = null;
function deferred() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) { result.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
  if (url.pathname.startsWith('/api/t1/') && !['GET', 'HEAD'].includes(request.method())) result.mutations.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
  if (request.method() === 'DELETE' && failDelete === url.pathname) { failDelete = null; return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture_delete_unavailable"}' }); }
  if (stale && request.method() === 'GET' && url.pathname === '/api/t1/workbench/runs') {
    const held = stale; stale = null; const response = await route.fetch(); held.captured.release(); await held.release.promise;
    try { return await route.fulfill({ response }); } catch { return; }
  }
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(String(error)));
const json = async path => { const response = await context.request.get(origin + '/api/t1/workbench/' + path); assert.equal(response.status(), 200, path); return response.json(); };
const sidebar = () => page.locator('[data-submission-list="sidebar"]');
const history = () => page.locator('[data-submission-list="history"]');
const opener = id => sidebar().locator(`[data-run-menu-id="${id}"]`);
const select = id => sidebar().locator(`[data-run-id="${id}"]`);
const dialog = () => page.getByRole('dialog', { name: '删除这次抽取记录', exact: true });
async function snapshot() { return page.evaluate(() => ({ url: location.href, run: new URL(location.href).searchParams.get('run'), record: document.querySelector('.t1-evidence-card')?.getAttribute('data-record-id'), text: document.querySelector('.t1-quote-frame')?.textContent, query: document.querySelector('.t1-record-search input')?.value })); }
async function showMenu(id) { await opener(id).click(); await page.locator('.sidebar-menu, .sidebar-sheet').waitFor(); }
async function confirmFor(id) { await showMenu(id); await page.getByRole('menuitem', { name: '删除这次抽取记录', exact: true }).click(); await dialog().waitFor(); assert.equal(await dialog().locator('[data-delete-run-id]').getAttribute('data-delete-run-id'), id); }
async function check(name, work) { await work(); result.checks.push(name); console.log('PASS ' + name); }
async function centeredDialog(label) {
  const rect = await dialog().boundingBox(), viewport = page.viewportSize();
  const offsets = { label, x: Math.abs(rect.x + rect.width / 2 - viewport.width / 2), y: Math.abs(rect.y + rect.height / 2 - viewport.height / 2) };
  result.dialog_positions.push(offsets); assert.ok(offsets.x <= 1 && offsets.y <= 1, JSON.stringify(offsets));
}
async function screenshot(name) { await page.screenshot({ path: join(evidence, name) }); result.screenshots.push(name); }
async function waitRun(id, state = 'completed') { for (let i = 0; i < 200; i++) { const run = (await json('runs')).runs.find(run => run.run_id === id); if (run?.state === state && run.result_ready) return run; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('fixture run wait timed out: ' + id); }
async function removeViaGateway(id) { return context.request.delete(origin + '/api/t1/workbench/runs/' + encodeURIComponent(id), { data: {} }); }
const persist = async () => { let report = {}; try { report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8')); } catch {} report.browser = result; await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); };
try {
  assert.equal((await json('capabilities')).controlled_fixture, true);
  await Promise.all([json('catalog'), json('models')]);
  await page.goto(origin + '/?' + new URLSearchParams({ paper: runtime.papers.current, run: ids.current, view: 'records' })); await page.locator('.t1-evidence-card').waitFor(); await page.evaluate(() => document.fonts.ready);
  assert.equal((await context.request.get(origin + '/_next/static/' + result.BUILD_ID + '/_buildManifest.js')).status(), 200);
  await check('sidebar_and_history_share_exact_submissions_without_upload_only_or_invented_legacy_batches', async () => {
    const runs = (await json('runs')).runs;
    assert.equal(await sidebar().locator('[data-run-id]').count(), runs.length);
    assert.equal(await sidebar().locator(`[data-paper-id="${runtime.papers.uploadOnly}"]`).count(), 0);
    assert.equal(await sidebar().locator('[data-submission-kind="batch"]').count(), 1);
    const legacy = runs.filter(run => !run.submission); assert.equal(await sidebar().locator('[data-submission-kind="unrecorded"]').count(), legacy.length);
    for (const run of legacy) assert.equal(await sidebar().locator(`[data-submission-group="run:${run.run_id}"] [data-task-kind="unrecorded"]`).count(), 1);
    await page.getByRole('tab', { name: '任务与历史', exact: true }).click(); await history().waitFor();
    assert.deepEqual(await sidebar().locator('[data-submission-group]').evaluateAll(elements => elements.map(element => element.dataset.submissionGroup)), await history().locator('[data-submission-group]').evaluateAll(elements => elements.map(element => element.dataset.submissionGroup)));
    await sidebar().locator('[data-submission-kind="batch"] > .t1-submission-heading').click();
    assert.equal(await history().locator('[data-submission-kind="batch"] > .t1-submission-heading').getAttribute('aria-expanded'), 'true');
    assert.equal(await history().locator('[data-submission-kind="batch"] [data-run-id]').count(), 2);
    await screenshot('submission-groups-desktop.png');
    assert.equal(await page.locator('.t1-content[data-view="tasks"] .t1-events').count(), 0);
    assert.equal(await page.getByText('删除此论文及其运行', { exact: true }).count(), 0);
    await page.getByRole('tab', { name: '抽取结果', exact: true }).click();
  });
  await check('same_paper_runs_and_menu_view_keep_the_exact_selected_extraction_and_keyboard_focus', async () => {
    await select(ids.older).click(); await page.waitForURL(url => url.searchParams.get('run') === ids.older); await page.locator('.t1-evidence-card').waitFor();
    await showMenu(ids.current); await page.getByRole('menuitem', { name: '查看这次抽取', exact: true }).click(); await page.waitForURL(url => url.searchParams.get('run') === ids.current); await page.locator('.t1-evidence-card').waitFor();
    await opener(ids.current).focus(); await page.keyboard.press('Enter'); await page.getByRole('menu', { name: '任务操作', exact: true }).waitFor(); await page.keyboard.press('Escape');
    assert.equal(await opener(ids.current).evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('button button').count(), 0);
  });
  await check('delete_confirmation_freezes_one_run_and_cancelling_it_never_sends_a_delete', async () => {
    await page.locator('.t1-record-search input').fill('CT'); const before = await snapshot(), count = result.mutations.length;
    await confirmFor(ids.older); await dialog().getByText('论文、PDF', { exact: false }).count();
    assert.ok((await dialog().textContent()).includes(ids.older)); assert.ok((await dialog().textContent()).includes('gpt-6-luna'));
    await centeredDialog('desktop'); await screenshot('delete-confirmation-desktop.png');
    await dialog().getByRole('button', { name: '保留这次记录', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
    assert.deepEqual(await snapshot(), before); assert.equal(result.mutations.length, count);
  });
  await check('noncurrent_delete_failure_retry_and_slow_workspace_read_do_not_switch_or_revive_results', async () => {
    const before = await snapshot(); await confirmFor(ids.older); failDelete = '/api/t1/workbench/runs/' + ids.older;
    await dialog().getByRole('button', { name: '确认删除这次记录', exact: true }).click(); await dialog().getByRole('alert').waitFor();
    assert.equal((await json('runs')).runs.some(run => run.run_id === ids.older), true); assert.deepEqual(await snapshot(), before);
    await dialog().getByRole('button', { name: '保留这次记录', exact: true }).click();
    const captured = deferred(), release = deferred(); stale = { captured, release };
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await captured.promise;
    assert.equal(await page.locator('.t1-refresh-center .t1-refresh-spinner').count(), 1);
    await confirmFor(ids.older); await dialog().getByRole('button', { name: '确认删除这次记录', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); release.release();
    await page.waitForFunction(id => !document.querySelector(`[data-run-id="${id}"]`), ids.older);
    assert.equal((await json('runs')).runs.some(run => run.run_id === ids.older), false); assert.deepEqual(await snapshot(), before);
    await page.getByRole('tab', { name: '任务与历史', exact: true }).click(); assert.equal(await history().locator(`[data-run-id="${ids.older}"]`).count(), 0); await page.getByRole('tab', { name: '抽取结果', exact: true }).click();
  });
  await check('active_and_terminal_finalization_are_refused_and_cancel_stays_scoped_to_the_selected_run', async () => {
    const before = await snapshot();
    for (const id of [ids.active, ids.finishing]) {
      await confirmFor(id); assert.equal(await dialog().getByRole('button', { name: '确认删除这次记录', exact: true }).isDisabled(), true);
      const refused = await removeViaGateway(id); assert.equal(refused.status(), 409); assert.equal((await refused.json()).error, 'paper_busy_before_deleting_run');
      await dialog().getByRole('button', { name: '保留这次记录', exact: true }).click();
    }
    await showMenu(ids.active); await page.getByRole('menuitem', { name: '取消此任务', exact: true }).click(); await page.locator('.t1-task-toast').filter({ hasText: '已取消此任务' }).waitFor();
    assert.equal((await json('runs')).runs.find(run => run.run_id === ids.active).state, 'cancelled'); assert.deepEqual(await snapshot(), before);
    await fetch(fixture + '/__fixture/release-finishing', { method: 'POST' }); await waitRun(ids.finishing);
  });
  await check('deleting_current_run_selects_remaining_result_of_the_same_paper', async () => {
    await confirmFor(ids.current); await dialog().getByRole('button', { name: '确认删除这次记录', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('run') === ids.spare); await page.locator('.t1-evidence-card').waitFor();
    assert.equal(await select(ids.spare).getAttribute('aria-current'), 'page'); assert.equal(await select(ids.current).count(), 0);
    assert.equal((await json('papers')).papers.some(paper => paper.id === runtime.papers.current), true);
  });
  await check('kept_export_and_model_scope_controls_still_work_through_the_gateway', async () => {
    await page.locator('.t1-exports > summary').click();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '保留结果 JSONL', exact: true }).click();
    const saved = await download, text = await readFile(await saved.path(), 'utf8'); assert.equal(text.trim().split('\n').length, 2);
    await page.getByRole('tab', { name: '创建任务', exact: true }).click(); await page.locator('.t1-model-selection').waitFor(); assert.equal(await page.getByRole('button', { name: '选择文件', exact: true }).count(), 1); assert.equal(await page.getByRole('button', { name: '选择文件夹', exact: true }).count(), 1);
    assert.ok((await page.locator('.t1-model-selection').textContent()).includes('gpt-6-luna')); await page.getByRole('tab', { name: '抽取结果', exact: true }).click();
  });
  await check('last_run_delete_opens_new_task_with_only_local_file_creation', async () => {
    await select(ids.last).click(); await page.waitForURL(url => url.searchParams.get('run') === ids.last); await confirmFor(ids.last); await dialog().getByRole('button', { name: '确认删除这次记录', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('view') === 'newTask' && !url.searchParams.has('run'));
    assert.equal(await page.locator('.t1-reuse-paper').count(), 0); assert.equal(await page.locator('.t1-batch-actions .t1-primary').isDisabled(), true); assert.equal(await select(ids.last).count(), 0);
    assert.equal(await page.getByLabel('选择 PDF', { exact: true }).count(), 1);
  });
  await check('mobile_batch_expansion_exact_menu_confirmation_and_layout_are_usable', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.t1-sidebar').waitFor({ state: 'detached' }); await page.getByRole('button', { name: '切换任务导航', exact: true }).click();
    const batch = sidebar().locator('[data-submission-kind="batch"]'); if (await batch.locator('> .t1-submission-heading').getAttribute('aria-expanded') !== 'true') await batch.locator('> .t1-submission-heading').click();
    await batch.scrollIntoViewIfNeeded(); const target = await opener(ids.batchA).boundingBox(); assert.ok(target.width >= 44 && target.height >= 44);
    await screenshot('submission-groups-mobile.png'); const before = await snapshot();
    await opener(ids.batchA).tap(); await page.getByRole('dialog', { name: '任务操作', exact: true }).waitFor(); await page.getByRole('menuitem', { name: '删除这次抽取记录', exact: true }).tap(); await dialog().waitFor();
    const rect = await dialog().boundingBox(); assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 391 && rect.y + rect.height <= 845); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await centeredDialog('mobile'); await screenshot('delete-confirmation-mobile.png'); await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); assert.deepEqual(await snapshot(), before);
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []);
  const audit = await (await fetch(fixture + '/__fixture/requests')).json(); result.fixture_audit = audit;
  assert.equal(audit.paid_model_calls, 0); assert.ok(audit.requests.some(request => request.method === 'DELETE' && request.path.endsWith(ids.older))); result.status = 'passed';
} catch (cause) { result.status = 'failed'; result.failure = String(cause?.stack ?? cause); await page.screenshot({ path: join(evidence, 'browser-failure.png') }).catch(() => {}); throw cause; }
finally { await persist(); await browser.close(); }
