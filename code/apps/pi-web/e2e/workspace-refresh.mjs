/** Read-only refresh overlay / layout regression. Never uploads, starts, exports or changes saved results. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = process.env.T1_UI_ORIGIN ?? 'http://127.0.0.1:30152';
const evidence = resolve(code, process.env.T1_EVIDENCE_DIR ?? 'docs/acceptance/batch-submission-2026-11-13');
const reportName = process.env.T1_REFRESH_REPORT ?? 'refresh-center';
await mkdir(evidence, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
await context.addInitScript(expected => { if (location.origin !== expected) return; try { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } catch {} }, origin);
const report = { origin, BUILD_ID: process.env.T1_EXPECT_BUILD_ID, checks: [], errors: [], blocked: [], max_layout_delta_px: 0, max_center_delta_px: 0, paid_model_calls: 0, write_requests: 0 };
let gate = null, fail = false;
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) {
    report.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient');
  }
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': read-only snapshot\n\n' });
  if (fail && /^\/api\/t1\/workbench\/runs\//.test(url.pathname)) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"t1_backend_unavailable"}' });
  if (gate && url.pathname.startsWith('/api/t1/')) { const held = gate, response = await route.fetch(); await held.promise; return route.fulfill({ response }); }
  return route.continue();
});
context.on('page', page => page.on('pageerror', error => report.errors.push(String(error))));
const page = await context.newPage();
const success = () => page.locator('.t1-refresh-toast[data-failed="false"]');
async function geometry() {
  return page.evaluate(() => {
    const boxes = {}, scroll = {};
    for (const selector of ['.t1-topbar', '.t1-body', '.t1-workspace-bar', '.tabbar-scroll', '.t1-content-region', '.t1-heading', '.t1-quote-frame', '.t1-source']) {
      const element = [...document.querySelectorAll(selector)].find(element => element.getClientRects().length); if (!element) continue;
      const rect = element.getBoundingClientRect(); boxes[selector] = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, rect[key]]));
    }
    for (const selector of ['.t1-content', '.t1-reader-scroll', '.t1-paper-list', '.t1-pdf-reader']) {
      const element = document.querySelector(selector); if (element) scroll[selector] = { top: element.scrollTop, height: element.scrollHeight };
    }
    return { boxes, scroll };
  });
}
function stable(before, after) {
  assert.deepEqual(Object.keys(after.boxes), Object.keys(before.boxes));
  for (const [selector, box] of Object.entries(before.boxes)) for (const key of ['x', 'y', 'width', 'height']) {
    const delta = Math.abs(box[key] - after.boxes[selector][key]); report.max_layout_delta_px = Math.max(report.max_layout_delta_px, delta); assert.ok(delta < .6, `${selector} ${key} shifted ${delta}px`);
  }
  assert.deepEqual(after.scroll, before.scroll, 'scroll position or scroll height changed');
}
function holdReads() { let release; const promise = new Promise(resolve => { release = resolve; }); gate = { promise, release }; return () => { gate = null; release(); }; }
async function busy(before, motion = true, screenshot) {
  const release = holdReads();
  try {
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await page.locator('.t1-content-region[aria-busy="true"] .t1-refresh-overlay').waitFor();
    assert.equal(await page.getByRole('button', { name: '正在刷新工作台…', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.t1-refresh-toast').count(), 0);
    stable(before, await geometry());
    for (const selector of ['.t1-content-region', '.t1-paper-list-region']) {
      const region = page.locator(selector); if (!await region.count()) continue;
      assert.equal(await region.locator('.t1-refresh-overlay').evaluate(element => getComputedStyle(element).position), 'absolute');
      assert.equal(await region.locator('.t1-refresh-overlay svg').count(), 0, 'individual refresh regions have only a veil');
    }
    const icon = page.locator('.t1-refresh-spinner'); assert.equal(await icon.count(), 1, 'exactly one waiting spinner');
    const box = await icon.boundingBox(), body = await page.locator('.t1-body').boundingBox(); assert.ok(box && body);
    const centerDelta = Math.max(Math.abs(box.x + box.width / 2 - body.x - body.width / 2), Math.abs(box.y + box.height / 2 - body.y - body.height / 2));
    report.max_center_delta_px = Math.max(report.max_center_delta_px, centerDelta); assert.ok(centerDelta < .6, 'waiting arrow must be at the visible workspace center');
    assert.equal(await icon.evaluate(element => getComputedStyle(element).animationName === 'none'), !motion);
    assert.equal(await page.locator('.t1-top-actions button[aria-busy="true"] svg').evaluate(element => getComputedStyle(element).visibility), 'hidden');
    if (await page.locator('.t1-sidebar').count()) assert.ok(await page.locator('.t1-refresh-center').evaluate(element => Number(getComputedStyle(element).zIndex)) > await page.locator('.t1-sidebar').evaluate(element => Number(getComputedStyle(element).zIndex) || 0));
    assert.equal(await page.locator('.t1-source .t1-refresh-overlay, .t1-topbar .t1-refresh-overlay, .tabbar-scroll .t1-refresh-overlay').count(), 0);
    if (screenshot) await page.screenshot({ path: join(evidence, (process.env.T1_REFRESH_SCREENSHOT_PREFIX ?? '') + screenshot) });
  } finally { release(); }
  await success().waitFor(); stable(before, await geometry());
  assert.equal(await success().evaluate(element => getComputedStyle(element).position), 'fixed');
}
async function check(name, work) { await work(); report.checks.push(name); }
try {
  const listed = await (await fetch('http://127.0.0.1:3210/api/workbench/runs')).json();
  const run = listed.runs.find(run => run.document_id === 'L07' && run.candidate_count > 1) ?? listed.runs.find(run => run.candidate_count > 1);
  assert.ok(run, 'saved run is required for a read-only regression');
  const value = await (await fetch('http://127.0.0.1:3210/api/workbench/runs/' + encodeURIComponent(run.run_id))).json();
  const record = [...value.output.records].sort((a, b) => b.fragments.reduce((sum, item) => sum + item.exact_quote.length, 0) - a.fragments.reduce((sum, item) => sum + item.exact_quote.length, 0))[0];
  await page.goto(origin + '/?' + new URLSearchParams({ paper: run.document_id, run: run.run_id, record: record.id, view: 'records' }));
  await page.locator('.t1-retention').waitFor(); await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.t1-task-picker [data-task-kind="' + (run.submission?.kind ?? 'unrecorded') + '"]').count(), 1);
  assert.equal(await page.locator('.t1-batch input[webkitdirectory]').count(), 1);
  if (process.env.T1_EXPECT_BUILD_ID) assert.equal((await context.request.get(origin + '/_next/static/' + process.env.T1_EXPECT_BUILD_ID + '/_buildManifest.js')).status(), 200);
  assert.equal(await page.locator('.t1-brand small, .t1-refresh-feedback').count(), 0);
  assert.equal(await page.locator('.t1-batch input[type="file"][multiple]:not([webkitdirectory])').count(), 1);
  assert.deepEqual(await page.locator('.t1-quote-frame [data-fragment-index]').allTextContents(), record.fragments.map(fragment => fragment.exact_quote));
  // A local draft exercises component continuity without any upload request.
  await page.getByRole('tab', { name: '创建任务', exact: true }).click();
  await page.getByLabel('选择 PDF', { exact: true }).setInputFiles({ name: 'unsubmitted-refresh-draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
  await page.locator('.t1-batch input[type="text"], .t1-batch .t1-field input:not([type="file"])').fill('刷新前草稿');
  const draftId = await page.locator('[data-batch-member]').getAttribute('data-batch-member');
  await page.getByRole('tab', { name: '抽取结果', exact: true }).click();
  await page.locator('.t1-source-toggle').click(); await page.locator('.t1-source .t1-pdf-reader canvas').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const selected = await page.locator('.t1-evidence-card').getAttribute('data-record-id');
  await check('one_workspace_centered_arrow_with_PDF_and_sidebar_shown_or_hidden', async () => {
    const before = await geometry();
    await busy(before, true, 'refresh-center-desktop-busy.png');
    assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-record-id'), selected);
    await page.locator('.t1-workspace-bar > button').first().click(); await page.locator('.t1-sidebar').waitFor({ state: 'hidden' }); await busy(await geometry());
    await page.locator('.t1-workspace-bar > button').first().click(); await page.locator('.t1-sidebar').waitFor();
  });
  await check('failure_and_toast_retry_preserve_geometry_without_inline_error', async () => {
    const before = await geometry(); fail = true;
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-refresh-toast[data-failed="true"]').waitFor();
    assert.ok((await page.locator('.t1-refresh-toast').innerText()).includes('刷新未完成'));
    assert.equal(await page.locator('.t1-content > .t1-alert, .t1-refresh-overlay').count(), 0); stable(before, await geometry());
    fail = false; await page.locator('.t1-refresh-toast').getByRole('button', { name: '重试', exact: true }).click(); await success().waitFor(); stable(before, await geometry());
  });
  await check('reader_and_list_scroll_stay_put_with_visible_centered_spinner', async () => {
    await page.setViewportSize({ width: 1440, height: 480 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('.t1-reader-scroll').evaluate(element => { element.scrollTop = Math.min(120, (element.scrollHeight - element.clientHeight) / 2); });
    await page.locator('.t1-paper-list').evaluate(element => { element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) / 2); });
    const before = await geometry(); assert.ok(before.scroll['.t1-reader-scroll'].top > 0); await busy(before);
  });
  await check('scrolled_new_task_keeps_file_title_and_scope_during_refresh', async () => {
    await page.getByRole('tab', { name: '创建任务', exact: true }).click(); await page.locator('.t1-content').evaluate(element => { element.scrollTop = 180; });
    const before = await geometry(); assert.ok(before.scroll['.t1-content'].top > 0); await busy(before);
    assert.equal(await page.locator('[data-batch-member]').getAttribute('data-batch-member'), draftId);
    assert.equal(await page.locator('.t1-batch .t1-field input:not([type="file"])').inputValue(), '刷新前草稿');
    assert.equal(await page.getByLabel('癌种', { exact: true }).inputValue(), 'all');
  });
  await check('mobile_reduced_motion_static_icon_and_floating_toast_leave_retention_actions_clear', async () => {
    await page.getByRole('tab', { name: '抽取结果', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('.t1-sidebar').waitFor({ state: 'hidden' });
    const before = await geometry(); await busy(before, false);
    await page.locator('.t1-workspace-bar > button').first().click(); await page.locator('.t1-sidebar').waitFor();
    const sidebar = await page.locator('.t1-sidebar').boundingBox(), body = await page.locator('.t1-body').boundingBox();
    assert.equal(sidebar.y, body.y); assert.equal(sidebar.height, body.height);
    await busy(await geometry(), false, 'refresh-center-mobile-busy.png');
    await page.locator('.t1-sidebar-close').click(); await page.locator('.t1-sidebar').waitFor({ state: 'hidden' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const toast = await success().boundingBox(), retention = await page.locator('.t1-retention-actions').boundingBox();
    assert.ok(toast.y + toast.height <= retention.y || toast.y >= retention.y + retention.height, 'toast must not cover keep/exclude actions');
    await success().getByRole('button', { name: '关闭', exact: true }).click(); assert.equal(await page.locator('.t1-refresh-toast').count(), 0);
  });
  await check('success_dismisses_and_background_polling_does_not_show_overlay_or_toast', async () => {
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await success().waitFor();
    await success().waitFor({ state: 'hidden', timeout: 6500 });
    await page.waitForResponse(response => response.url().endsWith('/api/t1/workbench/runs') && response.request().method() === 'GET', { timeout: 11000 });
    assert.equal(await page.locator('.t1-refresh-overlay, .t1-refresh-toast').count(), 0);
    assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-record-id'), selected);
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); throw error; }
finally { gate?.release(); await writeFile(join(evidence, reportName + '.json'), JSON.stringify(report, null, 2) + '\n'); await browser.close(); }
