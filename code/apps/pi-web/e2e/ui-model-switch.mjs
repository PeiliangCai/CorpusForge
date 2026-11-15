/** Same production build against an isolated fixture. All T1 API requests are intercepted before the production gateway. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30153', backend = 'http://127.0.0.1:3213';
const evidence = join(code, 'docs/acceptance/ui-model-switch-2026-11-13'); await mkdir(evidence, { recursive: true });
const report = { status: 'in_progress', formal_review: { used: 1, limit: 3 }, browser: { origin, backend, checks: [], errors: [], blocked: [], paid_model_calls: 0, production_write_requests: 0 },
  BUILD_ID: (await readFile(join(code, 'apps/pi-web/build/ui-model-switch-20261113/BUILD_ID'), 'utf8')).trim(), dist: 'apps/pi-web/build/ui-model-switch-20261113' };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin !== expected) return; localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); }, origin);
const submissions = []; let loseNextStart = false;
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (url.origin !== origin) { report.browser.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': isolated snapshot\n\n' });
  const start = method === 'POST' && /\/papers\/[^/]+\/runs$/.test(path);
  if (!['GET', 'HEAD'].includes(method) && !(method === 'POST' && (/\/workbench\/(?:models|papers)$/.test(path) || start))) {
    report.browser.blocked.push({ path, method }); return route.abort('blockedbyclient');
  }
  const headers = await request.allHeaders();
  if (start) submissions.push({ paper_id: path.split('/').at(-2), key: headers['x-t1-request-id'], ...request.postDataJSON() });
  const response = await fetch(backend + path.replace(/^\/api\/t1/, '/api') + url.search, { method,
    headers: Object.fromEntries(['content-type', 'x-t1-filename', 'x-t1-title', 'x-t1-request-id'].filter(key => headers[key]).map(key => [key, headers[key]])),
    ...(!['GET', 'HEAD'].includes(method) ? { body: request.postDataBuffer() } : {}) });
  if (start && loseNextStart && response.ok) { loseNextStart = false; return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"synthetic_response_lost"}' }); }
  await route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body: Buffer.from(await response.arrayBuffer()) });
});
const page = await context.newPage(); page.on('pageerror', error => report.browser.errors.push(error.message));
const json = async path => { const response = await fetch(backend + '/api/' + path); assert.equal(response.status, 200, path); return response.json(); };
const check = async (name, fn) => { await fn(); report.browser.checks.push(name); console.log('PASS ' + name); };
const newTask = async () => { if (!(await page.locator('.t1-new-task').isVisible())) await page.getByRole('button', { name: '切换论文导航', exact: true }).click(); await page.locator('.t1-new-task').click(); await page.locator('.t1-model-selection').waitFor(); };
const choose = async model => { await page.getByRole('button', { name: '抽取模型', exact: true }).click(); await page.getByRole('listbox').getByRole('option').filter({ hasText: model }).click(); };
const idle = () => page.locator('.t1-batch[aria-busy="false"]').waitFor();
const noScatteredBadges = async () => assert.equal(await page.locator('[data-task-kind]').evaluateAll(items => items.every(item => item.closest('.t1-sidebar'))), true);
let initial, custom;
try {
  await page.goto(origin); await page.locator('.t1-paper-list [data-task-kind="single"]').waitFor();
  initial = (await json('workbench/models')).profiles.find(profile => profile.configuration_source === 'server');
  await check('sidebar_type_matches_default_result_run_and_explicit_run_history_navigation', async () => {
    const runs = (await json('workbench/runs')).runs, older = runs.find(run => run.document_id === 'L01' && run.submission?.kind === 'single'), newer = runs.find(run => run.document_id === 'L01' && run.submission?.kind === 'batch');
    assert.ok(older.candidate_count > 0); assert.equal(newer.candidate_count, 0);
    const row = page.locator('[data-paper-id="L01"]'); assert.equal(await row.getAttribute('data-sidebar-run-id'), older.run_id); assert.equal(await row.locator('[data-task-kind]').getAttribute('data-task-kind'), 'single');
    await page.goto(origin + '/?' + new URLSearchParams({ paper: 'L01', run: newer.run_id, view: 'records' })); await page.locator('[data-paper-id="L01"] [data-task-kind="batch"]').waitFor();
    await page.locator('[data-paper-id="L01"]').click(); assert.equal(await page.locator('.t1-task-picker select').inputValue(), 'run:' + newer.run_id);
    await page.locator('.t1-task-picker summary').click(); await page.locator('.t1-task-picker select').selectOption('run:' + older.run_id); await page.locator('[data-paper-id="L01"] [data-task-kind="single"]').waitFor();
    await page.locator('[data-paper-id="L05"]').click(); await page.locator('[data-paper-id="L05"] [data-task-kind="unrecorded"]').waitFor(); await noScatteredBadges();
  });
  await newTask();
  await check('upload_copy_is_precise_in_three_locales_and_preserves_batch_limits', async () => {
    const help = page.locator('.t1-batch .t1-lead'); assert.equal(await help.textContent(), '可选择 PDF 文件或文件夹，每批最多 20 篇、每篇不超过 50 MiB。先上传，再根据所选范围开始抽取。');
    await page.locator('.t1-top-actions select').selectOption('en'); assert.equal(await help.textContent(), 'Choose PDFs or a folder, up to 20 papers per selection and 50 MiB per file. Upload first, then start extraction according to the selected scope.');
    await page.locator('.t1-top-actions select').selectOption('zh-TW'); assert.equal(await help.textContent(), '可選擇 PDF 檔案或資料夾，每批最多 20 篇、每篇不超過 50 MiB。先上傳，再根據所選範圍開始擷取。');
    await page.locator('.t1-top-actions select').selectOption('zh-CN');
  });
  await check('adding_a_model_uses_saved_server_profiles_and_browser_choice_survives_reload', async () => {
    await page.locator('.t1-model-add > summary').click(); await page.getByLabel('模型 ID', { exact: true }).fill('gpt-4.1-mini');
    await page.getByRole('button', { name: '保存并选择', exact: true }).click(); await page.getByRole('button', { name: '抽取模型', exact: true }).filter({ hasText: 'gpt-4.1-mini' }).waitFor();
    custom = (await json('workbench/models')).profiles.find(profile => profile.model_id === 'gpt-4.1-mini');
    assert.deepEqual([custom.api, custom.reasoning_effort, custom.context_window, custom.max_output_tokens], ['openai-completions', 'none', 32768, 4096]);
    assert.ok((await page.locator('.t1-model-selection').textContent()).includes('兼容性未实测'));
    assert.equal(submissions.length, 0); await page.reload(); await newTask();
    assert.equal(await page.evaluate(() => localStorage.getItem('t1:extraction-model-profile')), custom.profile_id);
    assert.ok((await page.getByRole('button', { name: '抽取模型', exact: true }).textContent()).includes('gpt-4.1-mini'));
    await page.screenshot({ path: join(evidence, 'model-selector-desktop.png'), fullPage: true });
  });
  await check('batch_start_freezes_model_with_scope_and_submission_across_lost_response_and_switch', async () => {
    await choose('gpt-6-luna');
    await page.locator('.t1-batch input[type="file"]').first().setInputFiles(['one.pdf', 'two.pdf'].map(name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% MODEL UI ENGINEERING STUB ' + name + '\n%%EOF\n') })));
    await page.getByRole('button', { name: '上传待处理 PDF（2 篇）', exact: true }).click(); await idle();
    const added = (await json('workbench/papers')).papers.filter(paper => paper.uploaded);
    for (const paper of added) assert.equal(await page.locator(`[data-paper-id="${paper.id}"] [data-task-kind]`).count(), 0);
    loseNextStart = true; await page.getByRole('button', { name: '批量开始抽取（2 篇）', exact: true }).click(); await idle();
    assert.equal(await page.getByRole('button', { name: '重试提交抽取', exact: true }).count(), 1); const first = submissions[0];
    await choose('gpt-4.1-mini'); await page.getByRole('button', { name: '重试提交抽取', exact: true }).click(); await idle();
    const replay = submissions.at(-1); assert.equal(replay.key, first.key); assert.equal(replay.model_profile_id, initial.profile_id); assert.deepEqual(replay.scope, first.scope); assert.deepEqual(replay.submission, first.submission);
    const batchRuns = (await json('workbench/runs')).runs.filter(run => added.some(paper => paper.id === run.document_id)); assert.equal(batchRuns.length, 2);
    assert.ok(batchRuns.every(run => run.model_id === initial.model_id && run.model_profile.profile_id === initial.profile_id));
    assert.equal(await page.locator('[data-batch-model]').getAttribute('data-batch-model'), initial.profile_id); await noScatteredBadges();
    report.browser.batch_model_frozen = initial.profile_id;
  });
  await check('unavailable_remembered_profile_requires_reselection_and_disables_start', async () => {
    await page.evaluate(() => localStorage.setItem('t1:extraction-model-profile', 'model-' + 'f'.repeat(32))); await page.reload(); await newTask();
    await page.getByText('原选择的模型不可用，请重新选择后再开始新任务。', { exact: true }).waitFor(); assert.equal(await page.locator('.t1-batch-actions .t1-primary').isDisabled(), true);
    await choose('gpt-6-luna'); assert.equal(await page.locator('.t1-batch-actions .t1-primary').isDisabled(), true); await page.locator('.t1-batch input[type="file"]').first().setInputFiles({ name: 'available-model.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% AVAILABLE MODEL\n%%EOF\n') }); await page.locator('[data-batch-member]').waitFor(); await page.getByRole('button', { name: '上传待处理 PDF（1 篇）', exact: true }).click(); await idle(); assert.equal(await page.locator('.t1-batch-actions .t1-primary').isEnabled(), true);
  });
  await check('mobile_model_picker_and_advanced_form_fit_without_scattered_type_badges', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.t1-model-selection').waitFor(); await page.getByRole('button', { name: '抽取模型', exact: true }).click();
    await page.getByRole('listbox').waitFor(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: join(evidence, 'model-picker-mobile.png') });
    await page.keyboard.press('Escape'); await page.locator('.t1-model-add > summary').click(); await page.locator('.t1-model-add form details > summary').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await noScatteredBadges(); await page.screenshot({ path: join(evidence, 'model-add-mobile.png'), fullPage: true });
  });
  assert.deepEqual(report.browser.errors, []); assert.deepEqual(report.browser.blocked, []); report.browser.status = 'passed'; report.status = 'engineering_verified_pending_final_review_and_deployment';
} catch (error) { report.browser.status = 'failed'; report.browser.failure = error.stack ?? String(error); await page.screenshot({ path: join(evidence, 'browser-failure.png'), fullPage: true }); throw error; }
finally {
  report.browser.submissions = submissions; await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const run of (await json('workbench/runs')).runs) if (!['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.state)) await fetch(backend + '/api/workbench/runs/' + run.run_id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await browser.close();
}
