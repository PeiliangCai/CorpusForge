/** Production smoke check: GET/HEAD only; never clicks any cancel action. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30141';
const evidence = join(code, 'docs/acceptance/sidebar-task-actions-2026-11-13');
const report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8'));
const result = { status: 'in_progress', checks: [], blocked: [], errors: [], production_write_requests: 0, paid_model_calls: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', hasTouch: true });
await context.addInitScript(expected => { if (location.origin !== expected) return; localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); }, origin);
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) {
    result.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient');
  }
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': production read-only snapshot\n\n' });
  return route.continue();
});
const page = await context.newPage(); page.on('pageerror', error => result.errors.push(String(error)));
const json = async path => { const response = await fetch(origin + '/api/t1/workbench/' + path); assert.equal(response.status, 200); return response.json(); };
const opener = id => page.locator(`.t1-paper-row:has([data-paper-id="${id}"]) .t1-paper-actions`);
async function snapshot() { return page.evaluate(() => ({ url: location.href, record: document.querySelector('.t1-evidence-card')?.getAttribute('data-record-id'), text: document.querySelector('.t1-quote-frame')?.textContent, picker: document.querySelector('.t1-task-picker select')?.value })); }
async function check(name, work) { await work(); result.checks.push(name); console.log('PASS ' + name); }
try {
  const runs = (await json('runs')).runs, papers = (await json('papers')).papers;
  const selected = runs.find(run => run.candidate_count > 0); assert.ok(selected);
  await page.goto(origin + '/?' + new URLSearchParams({ paper: selected.document_id, run: selected.run_id, view: 'records' }));
  await page.locator('.t1-evidence-card').waitFor(); await page.evaluate(() => document.fonts.ready); const before = await snapshot();
  await check('same_reviewed_build_existing_results_and_always_visible_menu_buttons', async () => {
    assert.equal((await context.request.get(origin + '/_next/static/' + report.BUILD_ID + '/_buildManifest.js')).status(), 200);
    assert.equal(await page.locator('button button').count(), 0); assert.equal(await page.locator('.t1-paper-actions').count(), papers.length);
    await page.mouse.move(1000, 500); assert.ok(await opener(selected.document_id).isVisible());
    assert.equal(await page.locator('[data-task-kind]').evaluateAll(elements => elements.every(element => element.closest('.t1-sidebar'))), true);
  });
  await check('selected_and_other_paper_menus_preserve_current_result_and_query', async () => {
    for (const id of [selected.document_id, papers.find(paper => paper.id !== selected.document_id).id]) {
      await opener(id).click(); const menu = page.getByRole('menu', { name: '任务操作', exact: true }); await menu.waitFor();
      const current = (await json('runs')).runs.filter(run => run.document_id === id && ['queued', 'parsing', 'extracting', 'reconciling'].includes(run.state));
      assert.deepEqual(new Set(await page.locator('[data-cancel-run-id]').evaluateAll(elements => elements.map(element => element.dataset.cancelRunId))), new Set(current.map(run => run.run_id)));
      if (!current.length) await menu.getByText('暂无可取消的任务', { exact: true }).waitFor();
      assert.deepEqual(await snapshot(), before); await page.keyboard.press('Escape'); assert.equal(await opener(id).evaluate(element => element === document.activeElement), true);
    }
    await opener(selected.document_id).click(); await page.screenshot({ path: join(evidence, 'production-menu-desktop.png') });
    await page.locator('.t1-workspace-bar > span').click(); await page.getByRole('menu', { name: '任务操作', exact: true }).waitFor({ state: 'detached' }); assert.deepEqual(await snapshot(), before);
  });
  await check('view_history_is_available_without_changing_run', async () => {
    await opener(selected.document_id).click(); await page.getByRole('menuitem', { name: '查看任务与历史', exact: true }).click();
    await page.locator('.t1-content[data-view="tasks"]').waitFor(); assert.equal(new URL(page.url()).searchParams.get('run'), selected.run_id);
    await page.getByRole('tab', { name: '抽取结果', exact: true }).click(); await page.locator('.t1-evidence-card').waitFor(); assert.deepEqual(await snapshot(), before);
  });
  await check('mobile_touch_target_sheet_and_no_horizontal_overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.t1-sidebar').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '切换论文导航', exact: true }).click(); const original = await snapshot();
    const target = await opener(selected.document_id).boundingBox(); assert.ok(target.width >= 44 && target.height >= 44);
    await opener(selected.document_id).tap(); await page.getByRole('dialog', { name: '任务操作', exact: true }).waitFor();
    const rect = await page.locator('.sidebar-sheet').boundingBox(); assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 391 && rect.y + rect.height <= 845);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(await snapshot(), original);
    await page.screenshot({ path: join(evidence, 'production-menu-mobile.png') });
    await page.locator('.sidebar-sheet-backdrop').click({ position: { x: 10, y: 10 } }); await page.locator('.sidebar-sheet').waitFor({ state: 'detached' }); assert.deepEqual(await snapshot(), original);
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.status = 'passed';
} catch (cause) { result.status = 'failed'; result.failure = String(cause?.stack ?? cause); throw cause; }
finally { report.production_readonly = result; await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await browser.close(); }
