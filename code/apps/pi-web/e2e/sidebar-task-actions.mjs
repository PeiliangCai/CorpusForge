/** One production build, all API calls redirected to an isolated workflow fixture. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30154', backend = 'http://127.0.0.1:3214';
const evidence = join(code, 'docs/acceptance/sidebar-task-actions-2026-11-13'); await mkdir(evidence, { recursive: true });
const runtime = JSON.parse(await readFile(join(code, process.env.T1_TASK_ACTIONS_FIXTURE_DIR ?? 'runtime-data/sidebar-task-actions-fixture-20261113-v5', 'runtime.json'), 'utf8')), ids = runtime.runs;
const report = { status: 'browser_in_progress', formal_review: { used: 1, limit: 3 }, dist: 'apps/pi-web/build/sidebar-task-actions-20261113',
  BUILD_ID: (await readFile(join(code, 'apps/pi-web/build/sidebar-task-actions-20261113/BUILD_ID'), 'utf8')).trim(),
  browser: { origin, backend, checks: [], errors: [], blocked: [], cancellation_requests: [], production_write_requests: 0, paid_model_calls: 0 },
  baseline: JSON.parse(await readFile(join(evidence, 'baseline/production.json'), 'utf8')) };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', hasTouch: true });
await context.addInitScript(expected => { if (location.origin !== expected) return; localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); }, origin);
let cancelGate = null, failNext = false, staleGate = null, detailGate = null, failNextDetail = false;
function deferred() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (url.origin !== origin) { report.browser.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': isolated snapshot\n\n' });
  const cancel = method === 'POST' && /\/workbench\/runs\/[^/]+\/cancel$/.test(path);
  if (!['GET', 'HEAD'].includes(method) && !cancel) { report.browser.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
  if (failNextDetail && method === 'GET' && path === `/api/t1/workbench/runs/${ids.parsing}` && !detailGate) {
    failNextDetail = false; return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture_detail_read_unavailable"}' });
  }
  if (cancel) {
    report.browser.cancellation_requests.push({ run_id: decodeURIComponent(path.split('/').at(-2)), method, body: request.postDataJSON() });
    if (cancelGate) await cancelGate.promise;
    if (failNext) { failNext = false; return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"fixture_cancel_unavailable"}' }); }
  }
  const response = await fetch(backend + path.replace(/^\/api\/t1/, '/api') + url.search, { method,
    ...(!['GET', 'HEAD'].includes(method) ? { headers: { 'content-type': 'application/json' }, body: request.postDataBuffer() } : {}) });
  const body = Buffer.from(await response.arrayBuffer());
  if (detailGate && method === 'GET' && path === `/api/t1/workbench/runs/${ids.parsing}`) {
    const held = detailGate; detailGate = null; held.captured.release(); await held.release.promise;
  }
  if (staleGate && method === 'GET' && path === '/api/t1/workbench/runs') {
    const held = staleGate; staleGate = null; held.captured.release(); await held.release.promise;
  }
  return route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body });
});
const page = await context.newPage(); page.on('pageerror', error => report.browser.errors.push(String(error)));
const json = async path => { const response = await fetch(backend + '/api/workbench/' + path); assert.equal(response.status, 200, path); return response.json(); };
const menu = () => page.getByRole('menu', { name: '任务操作', exact: true });
const opener = paper => page.locator(`.t1-paper-row:has([data-paper-id="${paper}"]) .t1-paper-actions`);
const action = id => page.locator(`[data-cancel-run-id="${id}"]`);
const notice = () => page.locator('.t1-task-toast');
const check = async (name, work) => { await work(); report.browser.checks.push(name); console.log('PASS ' + name); };
const persist = () => writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
async function snapshot() {
  return page.evaluate(() => {
    const card = document.querySelector('.t1-evidence-card'), heading = document.querySelector('.t1-heading');
    return { url: location.href, paper: document.querySelector('[data-paper-id][aria-current="page"]')?.getAttribute('data-paper-id'),
      record: card?.getAttribute('data-record-id'), text: document.querySelector('.t1-quote-frame')?.textContent,
      picker: document.querySelector('.t1-task-picker select')?.value, query: document.querySelector('.t1-record-search input')?.value,
      contentTop: document.querySelector('.t1-content-region')?.getBoundingClientRect().top, headingTop: heading?.getBoundingClientRect().top };
  });
}
async function show(paper) { await opener(paper).click(); await menu().waitFor(); }
async function cancelled(id) { await notice().filter({ hasText: '已取消此任务' }).waitFor(); assert.equal((await json('runs')).runs.find(run => run.run_id === id).state, 'cancelled'); }
async function bounds(element) {
  const rect = await element.boundingBox(), viewport = page.viewportSize(); assert.ok(rect); assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, JSON.stringify({ rect, viewport }));
}
try {
  assert.equal((await json('capabilities')).controlled_fixture, true);
  await page.goto(origin + '/?' + new URLSearchParams({ paper: 'L01', run: ids.saved, view: 'records' }));
  await page.locator('.t1-evidence-card').waitFor(); await page.evaluate(() => document.fonts.ready);
  assert.equal((await context.request.get(origin + '/_next/static/' + report.BUILD_ID + '/_buildManifest.js')).status(), 200);
  const savedDetail = await json('runs/' + ids.saved);
  await page.locator('.t1-record-search input').fill(savedDetail.output.records[0].fragments[0].exact_quote.slice(0, 8));
  const original = await snapshot();
  await check('always_visible_sibling_button_lists_all_active_runs_without_selecting_them', async () => {
    assert.equal(await page.locator('button button').count(), 0);
    assert.equal(await page.locator('.t1-paper-actions').count(), (await json('papers')).papers.length);
    await page.mouse.move(1000, 500); assert.ok(await opener('L01').isVisible());
    assert.equal(await opener('L01').getAttribute('title'), '任务操作');
    assert.equal(await page.locator('[data-paper-id="L01"]').getAttribute('data-sidebar-run-id'), ids.saved);
    await show('L01'); assert.deepEqual(await snapshot(), original);
    assert.deepEqual(new Set(await page.locator('[data-cancel-run-id]').evaluateAll(elements => elements.map(element => element.dataset.cancelRunId))), new Set([ids.parsing, ids.queued, ids.secondQueued]));
    for (const id of [ids.parsing, ids.queued, ids.secondQueued]) { assert.ok((await action(id).textContent()).includes(id.slice(-8))); assert.ok(await action(id).locator('time').getAttribute('datetime')); }
    assert.equal(await menu().evaluate(element => element.parentElement === document.body), true);
    await bounds(menu()); await page.screenshot({ path: join(evidence, 'task-menu-desktop.png') });
    await page.setViewportSize({ width: 1024, height: 320 }); await bounds(menu());
    await page.screenshot({ path: join(evidence, 'task-menu-short-viewport.png') });
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check('keyboard_escape_focus_return_and_outside_click_keep_navigation', async () => {
    await opener('L01').focus(); await page.keyboard.press('Enter'); await menu().waitFor();
    await page.keyboard.press('ArrowDown'); assert.ok(await page.locator('[data-cancel-run-id]:focus').count());
    await page.keyboard.press('Escape'); await menu().waitFor({ state: 'detached' }); assert.equal(await opener('L01').evaluate(element => element === document.activeElement), true);
    await show('L01'); await page.locator('.t1-workspace-bar > span').click(); await menu().waitFor({ state: 'detached' });
    assert.deepEqual(await snapshot(), original); assert.equal(report.browser.cancellation_requests.length, 0);
  });
  await check('noncurrent_paper_pending_deduplication_failure_after_sidebar_close_and_retry', async () => {
    failNext = true; cancelGate = deferred(); await show('L07'); await action(ids.retry).click();
    await notice().filter({ hasText: '正在取消' }).waitFor(); assert.deepEqual(await snapshot(), original);
    await show('L07'); assert.equal(await action(ids.retry).getAttribute('aria-disabled'), 'true');
    await action(ids.retry).dispatchEvent('click'); await action(ids.retry).dispatchEvent('click');
    assert.equal(report.browser.cancellation_requests.length, 1);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '切换论文导航', exact: true }).click();
    await page.locator('.t1-sidebar').waitFor({ state: 'detached' }); cancelGate.release(); cancelGate = null;
    await notice().filter({ hasText: '取消未确认' }).waitFor(); assert.equal(await notice().getAttribute('role'), 'alert');
    assert.equal(await notice().evaluate(element => getComputedStyle(element).position), 'fixed'); await bounds(notice());
    assert.equal(await page.locator('.t1-alert').count(), 0); assert.deepEqual({ ...await snapshot(), paper: original.paper }, original);
    await page.screenshot({ path: join(evidence, 'cancel-failure-sidebar-closed.png') });
    await notice().getByRole('button', { name: '重试', exact: true }).click(); await cancelled(ids.retry);
    await page.getByRole('button', { name: '切换论文导航', exact: true }).click(); await show('L07');
    assert.equal(await action(ids.retry).count(), 0); await menu().getByText('暂无可取消的任务', { exact: true }).waitFor(); await page.keyboard.press('Escape');
    assert.deepEqual(await snapshot(), original); assert.deepEqual(report.browser.cancellation_requests.map(item => item.run_id), [ids.retry, ids.retry]);
  });
  await check('one_queued_run_cancelled_without_cancelling_other_runs_or_switching_saved_results', async () => {
    const before = (await json('runs')).runs; await show('L01'); await action(ids.queued).click(); await cancelled(ids.queued);
    const after = (await json('runs')).runs; for (const id of [ids.saved, ids.parsing, ids.secondQueued]) assert.equal(after.find(run => run.run_id === id).state, before.find(run => run.run_id === id).state);
    assert.equal(after.find(run => run.run_id === ids.saved).candidate_count, before.find(run => run.run_id === ids.saved).candidate_count);
    await show('L01'); assert.equal(await action(ids.queued).count(), 0); assert.equal(await page.locator('[data-cancel-run-id]').count(), 2); await page.keyboard.press('Escape'); assert.deepEqual(await snapshot(), original);
  });
  await check('terminal_race_and_derived_finalization_follow_actual_cancel_responses', async () => {
    await show('L05'); await action(ids.race).click(); await notice().filter({ hasText: '任务已结束，无需取消' }).waitFor();
    assert.equal((await json('runs')).runs.find(run => run.run_id === ids.race).state, 'completed'); assert.ok(!(await notice().textContent()).includes('已取消此任务'));
    await show('L02'); await action(ids.finishing).click(); await notice().filter({ hasText: '任务正在收尾，未取消' }).waitFor();
    assert.equal((await json('runs')).runs.find(run => run.run_id === ids.finishing).state, 'reconciling');
    await show('L02'); await action(ids.finishing).filter({ hasText: '汇总核验中' }).waitFor(); await page.keyboard.press('Escape'); assert.deepEqual(await snapshot(), original);
  });
  await check('older_workspace_list_response_cannot_restore_cancelled_run_and_one_center_refresh_is_preserved', async () => {
    const captured = deferred(), release = deferred(); staleGate = { captured, release };
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await captured.promise;
    assert.equal(await page.locator('.t1-refresh-center .t1-refresh-spinner').count(), 1); assert.equal(await page.locator('.t1-refresh-overlay svg').count(), 0);
    await show('L01'); await action(ids.secondQueued).click(); await cancelled(ids.secondQueued); release.release();
    await page.locator('.t1-refresh-toast').filter({ hasText: '已更新论文列表' }).waitFor();
    await show('L01'); assert.equal(await action(ids.secondQueued).count(), 0); assert.equal(await page.locator('[data-cancel-run-id]').count(), 1); await page.keyboard.press('Escape');
    assert.deepEqual(await snapshot(), original);
  });
  await check('explicit_run_history_navigation_and_sidebar_only_kind_labels_remain', async () => {
    await page.locator('.t1-task-picker summary').click(); await page.locator('.t1-task-picker select').selectOption('run:' + ids.parsing);
    await page.locator('.t1-task-progress[data-state="parsing"]').waitFor(); assert.equal(await page.locator('[data-paper-id="L01"]').getAttribute('data-sidebar-run-id'), ids.parsing);
    await page.locator('[data-paper-id="L01"]').click(); assert.equal(await page.locator('.t1-task-picker select').inputValue(), 'run:' + ids.parsing);
    if (!await page.locator('.t1-task-picker select').isVisible()) await page.locator('.t1-task-picker summary').click();
    await page.locator('.t1-task-picker select').selectOption('run:' + ids.saved); await page.locator('.t1-evidence-card').waitFor();
    await page.goto(origin + '/?' + new URLSearchParams({ paper: 'L01', history: ids.saved, view: 'records' })); await page.locator('.t1-evidence-card').waitFor();
    await page.locator('[data-paper-id="L01"] [data-task-kind="unrecorded"]').waitFor();
    const historical = await snapshot(); assert.ok(new URL(historical.url).searchParams.get('history')); assert.equal(new URL(historical.url).searchParams.get('run'), null);
    await show('L01'); await action(ids.parsing).waitFor(); await page.keyboard.press('Escape'); assert.deepEqual(await snapshot(), historical);
    await show('MED03'); await menu().getByText('暂无可取消的任务', { exact: true }).waitFor(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-paper-id="MED03"] [data-task-kind]').count(), 0);
    assert.equal(await page.locator('[data-task-kind]').evaluateAll(elements => elements.every(element => element.closest('.t1-sidebar'))), true);
    await page.goto(origin + '/?' + new URLSearchParams({ paper: 'L01', run: ids.parsing, view: 'records' })); await page.locator('.t1-task-progress[data-state="parsing"]').waitFor();
  });
  await check('mobile_touch_menu_visible_outside_close_and_current_task_cancellation', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.t1-sidebar').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '切换论文导航', exact: true }).click(); const before = await snapshot();
    const rect = await opener('L01').boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44);
    await opener('L01').tap(); await page.getByRole('dialog', { name: '任务操作', exact: true }).waitFor();
    await bounds(page.locator('.sidebar-sheet')); await bounds(action(ids.parsing)); assert.deepEqual(await snapshot(), before);
    await page.screenshot({ path: join(evidence, 'task-menu-mobile.png') });
    await page.locator('.sidebar-sheet-backdrop').click({ position: { x: 10, y: 10 } }); await page.locator('.sidebar-sheet').waitFor({ state: 'detached' }); assert.ok(await opener('L01').isVisible());
    const captured = deferred(), release = deferred(); detailGate = { captured, release };
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await captured.promise; failNextDetail = true;
    await opener('L01').tap(); await action(ids.parsing).tap(); await notice().filter({ hasText: '正在取消' }).waitFor();
    await page.locator('.t1-task-progress[data-state="cancelled"]').waitFor();
    await page.evaluate(() => {
      window.__cancelStates = [];
      window.__cancelObserver = new MutationObserver(() => window.__cancelStates.push(document.querySelector('.t1-task-progress')?.getAttribute('data-state')));
      window.__cancelObserver.observe(document.querySelector('.t1-task-progress'), { attributes: true, attributeFilter: ['data-state'] });
    });
    // The held pre-cancel GET is stale; the following current-detail refresh fails.
    // The successful POST must remain visible without inserting a body alert.
    release.release(); await cancelled(ids.parsing); await notice().filter({ hasText: '部分状态读取失败' }).waitFor(); await page.locator('.t1-task-progress[data-state="cancelled"]').waitFor();
    assert.deepEqual(await page.evaluate(() => { window.__cancelObserver.disconnect(); return window.__cancelStates.filter(state => state !== 'cancelled'); }), []);
    assert.equal(await page.locator('.t1-alert').count(), 0);
    assert.equal(await page.locator('.t1-task-progress').getByRole('button', { name: '取消此任务', exact: true }).count(), 0); assert.deepEqual(await snapshot(), before);
    await notice().getByRole('button', { name: '关闭', exact: true }).click(); await opener('L01').tap(); await page.getByText('暂无可取消的任务', { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, 'task-menu-no-active-mobile.png') });
  });
  assert.deepEqual(report.browser.errors, []); assert.deepEqual(report.browser.blocked, []); assert.ok(report.browser.cancellation_requests.every(request => request.method === 'POST' && JSON.stringify(request.body) === '{}'));
  report.status = 'awaiting_final_review';
} catch (cause) {
  report.status = 'browser_failed'; report.browser.failure = String(cause?.stack ?? cause); await page.screenshot({ path: join(evidence, 'browser-failure.png') }).catch(() => {}); throw cause;
} finally { cancelGate?.release(); staleGate?.release.release(); detailGate?.release.release(); await persist(); await browser.close(); }
