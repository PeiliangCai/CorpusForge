/** Production smoke: GET/HEAD only, including opening and cancelling confirmation. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30141', evidence = join(code, 'docs/acceptance/task-delete-entry-2026-11-13');
const report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8')), result = { status: 'in_progress', checks: [], errors: [], blocked: [], production_write_requests: 0, paid_model_calls: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers'); process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href), browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', hasTouch: true });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
await context.route(/^https?:\/\//, async route => { const request = route.request(), url = new URL(request.url()); if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) { result.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); } if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': read-only snapshot\n\n' }); return route.continue(); });
const page = await context.newPage(); page.on('pageerror', error => result.errors.push(String(error)));
const json = async path => { const response = await context.request.get(origin + '/api/t1/workbench/' + path); assert.equal(response.status(), 200); return response.json(); };
const check = async (name, work) => { await work(); result.checks.push(name); console.log('PASS ' + name); };
const snapshot = () => page.evaluate(() => ({ url: location.href, record: document.querySelector('.t1-evidence-card')?.getAttribute('data-record-id'), text: document.querySelector('.t1-quote-frame')?.textContent }));
try {
  const runs = (await json('runs')).runs, selected = runs.find(run => run.candidate_count > 0), other = runs.find(run => run.run_id !== selected.run_id); assert.ok(selected && other);
  await page.goto(origin + '/?' + new URLSearchParams({ paper: selected.document_id, run: selected.run_id, view: 'records' })); await page.locator('.t1-evidence-card').waitFor(); await page.evaluate(() => document.fonts.ready); const before = await snapshot();
  await check('reviewed_build_exact_run_navigation_and_preserved_existing_records', async () => {
    assert.equal((await context.request.get(origin + '/_next/static/' + report.BUILD_ID + '/_buildManifest.js')).status(), 200);
    assert.equal(await page.locator('[data-submission-list="sidebar"] [data-run-id]').count(), runs.length);
    assert.equal(await page.locator(`[data-run-id="${selected.run_id}"]`).getAttribute('aria-current'), 'page');
    await page.locator(`[data-run-menu-id="${other.run_id}"]`).click(); await page.getByRole('menuitem', { name: '删除这次抽取记录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除这次抽取记录', exact: true }); await dialog.waitFor(); assert.equal(await dialog.locator('[data-delete-run-id]').getAttribute('data-delete-run-id'), other.run_id); assert.deepEqual(await snapshot(), before);
    await page.screenshot({ path: join(evidence, 'production-confirmation-desktop.png') }); await dialog.getByRole('button', { name: '保留这次记录', exact: true }).click(); assert.deepEqual(await snapshot(), before);
  });
  await check('history_and_sidebar_have_identical_legacy_submission_groups', async () => {
    await page.getByRole('tab', { name: '任务与历史', exact: true }).click();
    const groupIds = variant => page.locator(`[data-submission-list="${variant}"] [data-submission-group]`).evaluateAll(elements => elements.map(element => element.dataset.submissionGroup)); assert.deepEqual(await groupIds('sidebar'), await groupIds('history'));
    assert.equal(await page.locator('[data-submission-list="history"] [data-submission-kind="unrecorded"]').count(), runs.filter(run => !run.submission).length);
    await page.screenshot({ path: join(evidence, 'production-history-desktop.png') }); await page.getByRole('tab', { name: '抽取结果', exact: true }).click(); assert.deepEqual(await snapshot(), before);
  });
  await check('mobile_task_menu_and_centered_confirmation_are_readonly_and_fit_viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.t1-sidebar').waitFor({ state: 'detached' }); await page.getByRole('button', { name: '切换任务导航', exact: true }).click();
    await page.locator(`[data-run-menu-id="${selected.run_id}"]`).tap(); await page.getByRole('dialog', { name: '任务操作', exact: true }).waitFor(); await page.getByRole('menuitem', { name: '删除这次抽取记录', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: '删除这次抽取记录', exact: true }), rect = await dialog.boundingBox(); assert.ok(Math.abs(rect.x + rect.width / 2 - 195) <= 1 && Math.abs(rect.y + rect.height / 2 - 422) <= 1); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(evidence, 'production-confirmation-mobile.png') }); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(await snapshot(), before);
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.status = 'passed';
} catch (error) { result.status = 'failed'; result.failure = String(error?.stack ?? error); throw error; }
finally { report.production_readonly = result; await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await browser.close(); }
