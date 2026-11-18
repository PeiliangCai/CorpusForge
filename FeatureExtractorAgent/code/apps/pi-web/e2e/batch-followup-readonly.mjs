/** Real task stays intact: all requests are GET/HEAD and confirmation is never clicked. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30141', backend = 'http://127.0.0.1:3210';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14'), reportPath = join(evidence, 'report.json');
const report = JSON.parse(await readFile(reportPath, 'utf8')), deployment = report.item4.followup_batch_delete_progress_layout_20261115.deployment;
const result = { status: 'running', BUILD_ID: deployment.BUILD_ID, checks: [], errors: [], blocked: [], production_business_writes: 0, paid_calls: 0, exports_requested: 0, real_task_deleted: false };
async function snapshot() { const out = {}; for (const name of ['runs', 'papers', 'models']) { const response = await fetch(backend + '/api/workbench/' + name); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); out[name] = { value: JSON.parse(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }; } return out; }
const before = await snapshot(), targetBatchId = '859a5ebd-6f6d-49e4-b7cf-50778327113f';
const members = before.runs.value.runs.filter(run => run.submission?.kind === 'batch' && run.submission.batch_id === targetBatchId); assert.equal(members.length, 2); assert.ok(members.every(run => run.task_title === '测试2'));
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href), browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) { result.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
  if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': readonly verification omits live stream\n\n' });
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => result.errors.push(String(error)));
const geometry = () => page.evaluate(() => Object.fromEntries(['.t1-batch-overview', '.t1-results-panel', '.t1-record-nav'].map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [selector, [rect.x, rect.y, rect.width, rect.height]]; })));
try {
  assert.equal((await context.request.head(origin + '/_next/static/' + deployment.BUILD_ID + '/_buildManifest.js')).status(), 200); assert.equal((await (await fetch(backend + '/health')).json()).status, 'ok'); result.checks.push('same_validated_build_and_backend_health');
  await page.goto(origin + '/?' + new URLSearchParams({ paper: members[0].document_id, run: members[0].run_id, view: 'records' })); await page.locator('.t1-evidence-card').waitFor();
  const expectedCount = members.reduce((sum, run) => sum + run.candidate_count, 0);
  await page.waitForFunction(expected => Number(document.querySelector('[data-retention-count="kept"]')?.textContent) + Number(document.querySelector('[data-retention-count="excluded"]')?.textContent) === expected, expectedCount);
  const expectedEnded = members.filter(run => ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.state) && run.result_ready !== false).length;
  const bar = page.getByRole('progressbar', { name: '已结束论文', exact: true }); assert.equal(await bar.getAttribute('aria-valuenow'), String(Math.floor(expectedEnded / members.length * 100))); assert.equal(await page.locator('[data-batch-results]').getAttribute('data-progress-outcome'), 'incomplete');
  const sourceId = await page.locator('.t1-evidence-card').getAttribute('data-source-run-id'); assert.ok(members.some(run => run.run_id === sourceId)); result.checks.push('real_batch_ended_ratio_and_run_bound_results');
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport); await page.locator('.t1-batch-overview').scrollIntoViewIfNeeded(); const beforeLayout = await geometry();
    const trigger = page.locator('.t1-batch-overview').getByRole('button', { name: '已提交论文', exact: true }); await trigger.click(); const membersDialog = page.getByRole('dialog', { name: '已提交论文', exact: true }); await membersDialog.waitFor(); assert.equal(await membersDialog.locator('[data-batch-member]').count(), members.length); assert.deepEqual(await geometry(), beforeLayout);
    await page.keyboard.press('Escape'); await membersDialog.waitFor({ state: 'hidden' }); assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await page.screenshot({ path: join(evidence, 'batch-followup-live-' + label + '.png') });
    if (viewport.width < 640 && !await page.locator('.t1-sidebar').isVisible()) await page.locator('.t1-workspace-bar > button').first().click();
    await page.locator('[data-submission-list="sidebar"] [data-task-menu-id="batch:' + targetBatchId + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click(); const confirmation = page.getByRole('dialog', { name: '删除任务', exact: true }); await confirmation.waitFor();
    assert.equal(await confirmation.getByRole('button', { name: '确认删除任务', exact: true }).isEnabled(), true); assert.equal(await confirmation.locator('[data-delete-batch]').getAttribute('data-delete-batch'), targetBatchId); assert.equal(await confirmation.locator('.t1-delete-members li').count(), 2);
    await page.screenshot({ path: join(evidence, 'batch-followup-live-delete-confirm-' + label + '.png') }); await confirmation.getByRole('button', { name: '保留任务', exact: true }).click(); await confirmation.waitFor({ state: 'hidden' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  result.checks.push('real_target_delete_confirmation_enabled_without_confirming_desktop_and_mobile');
  const after = await snapshot(); result.api_sha256_before = Object.fromEntries(Object.entries(before).map(([key, item]) => [key, item.sha256])); result.api_sha256_after = Object.fromEntries(Object.entries(after).map(([key, item]) => [key, item.sha256])); assert.deepEqual(result.api_sha256_before, result.api_sha256_after);
  assert.equal(after.runs.value.runs.filter(run => run.submission?.kind === 'batch' && run.submission.batch_id === targetBatchId).length, 2); result.run_count = after.runs.value.runs.length; result.paper_count = after.papers.value.papers.length; result.target_record_count = expectedCount; result.checks.push('GET_HEAD_preserves_real_target_and_all_task_paper_model_lists');
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = String(error); throw error; }
finally { await context.close(); await browser.close(); const current = JSON.parse(await readFile(reportPath, 'utf8')); current.item4.followup_batch_delete_progress_layout_20261115.live_readonly = { ...result, completed_at_utc: new Date().toISOString() }; await writeFile(reportPath, JSON.stringify(current, null, 2) + '\n'); console.log(JSON.stringify(result)); }
