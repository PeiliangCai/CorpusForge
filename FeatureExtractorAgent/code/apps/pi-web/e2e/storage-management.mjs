/** Real components or a production Next page; all business APIs are mocked in-browser. Never deletes real files. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), web = join(code, 'apps/pi-web');
const evidence = join(code, 'docs/acceptance/storage-management-2026-11-15'), production = Boolean(process.env.T1_STORAGE_ORIGIN), origin = process.env.T1_STORAGE_ORIGIN ?? 'http://127.0.0.1:30262';
const reportName = production ? 'same-build-browser.json' : 'frontend.json';
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const { build } = await import(pathToFileURL(join(code, 'node_modules/esbuild/lib/main.js')).href);
const bundle = production ? null : await build({ absWorkingDir: web, tsconfig: join(web, 'tsconfig.json'), bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' },
  stdin: { resolveDir: web, sourcefile: 'storage-management-fixture.tsx', loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { I18nProvider } from './hooks/useI18n';
    import { T1Workbench } from './t1/T1Workbench';
    createRoot(document.getElementById('root')).render(<I18nProvider><T1Workbench /></I18nProvider>);
  ` },
});
const css = production ? '' : await readFile(join(web, 't1/workbench.css'), 'utf8'), font = production ? null : await readFile(join(web, 'public/t1-assets/fonts/noto-cjk.woff2'));
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workbench.css"><style>*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
const report = { status: 'running', method: production ? 'Actual production Next page and static resources; every business API is fulfilled by Playwright. No requests reach the live business service.' : 'Actual T1Workbench, StorageManagement, GlobalToasts and CSS bundled with esbuild; all requests fulfilled by Playwright without a listening server.', origin, BUILD_ID: process.env.T1_STORAGE_BUILD_ID ?? null, checks: [], errors: [], blocked: [], next_static_resources: [], screenshots: [], paid_calls: 0, production_business_writes: 0, production_deletions: 0 };
if (process.env.T1_STORAGE_CASES && !production) {
  const previous = await readFile(join(evidence, reportName), 'utf8').then(JSON.parse).catch(() => null);
  if (previous) report.prior_mainline_validation = { status: previous.status, method: previous.method, checks: previous.checks, screenshots: previous.screenshots, note: 'Mainline verification before the narrow draft recovery change. The current run covers related scenarios only.' };
}
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const scope = { catalog_version: 'storage-fixture', matching_policy_version: 'storage-fixture', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
const catalog = { catalog_version: scope.catalog_version, cancers: [], image_types: [], features: [], bindings: [], default_scope: scope, restricted_available: true, development_only: false };
const candidate = (id, kind = 'orphan_parse') => ({ id, kind, name: id === 'upload-1' ? '两年前上传的研究资料.pdf' : `无引用资料 ${id} / 非常长的论文名称与说明.pdf`, bytes: 4096, files: 2, paper_ids: kind === 'unused_upload' ? ['unused-paper'] : [], detail: kind === 'unused_upload' ? 'unused_upload_and_unreferenced_artifacts' : 'unreferenced_generated_files', parts: [{ kind: kind === 'unused_upload' ? 'pdf' : 'parse', bytes: 3072, files: 1 }, { kind: 'figures', bytes: 1024, files: 1 }] });
function seed() {
  return { candidates: [candidate('upload-1', 'unused_upload'), ...Array.from({ length: 27 }, (_, index) => candidate('parse-' + (index + 1)))], requests: [], cleanups: [], previews: 0, cleanupError: null, partial: false, gate: null, reads: 0, uploads: 0, uploadRequests: [],
    papers: [{ id: 'unused-paper', title: 'unused.pdf', sha256: 'a'.repeat(64), language: 'en', pages: 1, note: '', output_ids: [], uploaded: true, filename: 'unused.pdf' }],
  };
}
function summary(state) {
  const reclaimable = state.candidates.reduce((size, item) => size + item.bytes, 0);
  return { schema_version: 't1-storage-summary-1', observed_at: '2026-11-15T00:00:00.000Z', scope: 'managed_workbench_files', total_bytes: 1048576 + reclaimable + 512, protected_bytes: 1048576, reclaimable_bytes: reclaimable, unknown_bytes: 512, file_count: 100 + state.candidates.length * 2,
    categories: [{ kind: 'pdf', bytes: 1048576, files: 2 }, { kind: 'parse', bytes: reclaimable, files: state.candidates.length * 2 }],
    protected_reasons: [{ code: 'referenced', bytes: 1044480, files: 98 }, { code: 'recent_upload', bytes: 4096, files: 2 }], disk: { total_bytes: 9999999999, available_bytes: 8888888888 }, cleanup_available: !state.busyPreview, ...(state.busyPreview ? { unavailable_reason: 'storage_busy' } : {}), policy: { automatic_cleanup: false, recent_upload_protection_hours: 24 } };
}
const gate = () => { let release; const promise = new Promise(done => { release = done; }); return { release, promise }; };
async function screenshot(page, name) { const filename = (production ? 'production-' : '') + name; await page.screenshot({ path: join(evidence, filename) }); report.screenshots.push(filename); }
async function frame(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('.t1-main').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, documentHeight: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight, url: location.href };
  });
}
async function assertBounded(page) {
  const result = await page.locator('.t1-storage-dialog').evaluate(element => {
    const box = element.getBoundingClientRect(), scroller = element.querySelector('.t1-storage-scroll'), footer = element.querySelector('.t1-storage-footer').getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, client: scroller.clientHeight, scroll: scroller.scrollHeight, footerBottom: footer.bottom, overflow: getComputedStyle(scroller).overflowY };
  });
  assert.ok(result.x >= 0 && result.y >= 0 && result.right <= result.width + 1 && result.bottom <= result.height + 1, JSON.stringify(result));
  assert.ok(result.footerBottom <= result.bottom && result.scroll > result.client && result.overflow === 'auto', JSON.stringify(result));
}
const panel = page => page.locator('.t1-storage-dialog');
const review = page => panel(page).getByRole('button', { name: '核对清理内容', exact: true });
const confirm = page => panel(page).getByRole('button', { name: '确认永久清理', exact: true });
const box = (page, id) => page.locator(`[data-storage-candidate-id="${id}"] input`);
async function open(page) {
  if (!await page.locator('.t1-sidebar').count()) await page.getByRole('button', { name: '展开任务导航', exact: true }).click();
  await page.getByRole('button', { name: '存储管理', exact: true }).click(); await panel(page).getByText('默认不选中任何资料，请核对名称与清理范围后勾选。', { exact: true }).waitFor();
}
async function scenario(name, work, { viewport = { width: 1440, height: 1000 }, clock = false } = {}) {
  if (process.env.T1_STORAGE_CASES && !process.env.T1_STORAGE_CASES.split(',').includes(name)) return;
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' }), state = seed();
  await context.addInitScript(() => { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); });
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(), base = '/api/t1/workbench';
    if (url.origin !== origin) { report.blocked.push({ name, path, method }); return route.abort('blockedbyclient'); }
    if (production && !path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (method === 'GET' && path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (method === 'GET' && path === '/workbench.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (method === 'GET' && path === '/t1-assets/fonts/noto-cjk.woff2') return route.fulfill({ contentType: 'font/woff2', body: font });
    if (path === '/favicon.ico') return route.fulfill({ status: 204 });
    state.requests.push({ method, path });
    if (method === 'GET' && path === base + '/capabilities') return json(route, { read_only: false, paper_upload: true, extraction_start: true, persisted_review: true, persisted_retention: true, retained_export: true, model_selection: false });
    if (method === 'GET' && path === base + '/catalog') return json(route, catalog);
    if (method === 'GET' && path === base + '/models') return json(route, { provider: 'fixture', default_profile_id: null, profiles: [] });
    if (method === 'GET' && path === base + '/runs') return json(route, { runs: [] });
    if (method === 'GET' && path === base + '/papers') { state.reads++; if (state.failNextPapers) { state.failNextPapers = false; return json(route, { error: 'fixture_papers_unavailable' }, 503); } return json(route, { papers: state.papers }); }
    if (method === 'POST' && path === base + '/storage/preview') {
      assert.deepEqual(request.postDataJSON(), {}); state.previews++;
      if (state.previewError) { const error = state.previewError; state.previewError = null; return json(route, { error }, 503); }
      return json(route, { schema_version: 't1-storage-preview-1', summary: summary(state), preview_id: 'preview-' + state.previews, version: 'version-' + state.previews, created_at: '2026-11-15T00:00:00Z', expires_at: '2026-11-15T00:10:00Z', candidates: state.busyPreview ? [] : state.candidates });
    }
    if (method === 'POST' && path === base + '/storage/cleanup') {
      const input = request.postDataJSON(); state.cleanups.push(input); if (state.gate) await state.gate.promise;
      if (state.cleanupError) { const error = state.cleanupError; state.cleanupError = null; if (error === 'storage_preview_stale') state.candidates = state.candidates.filter(item => item.id !== 'upload-1'); return json(route, { error }, error === 'storage_preview_expired' ? 410 : 409); }
      const selected = state.candidates.filter(item => input.candidate_ids.includes(item.id)), removed = state.partial ? selected.slice(0, 1) : selected;
      const removedPaperIds = removed.flatMap(item => item.paper_ids); state.papers = state.papers.filter(paper => !removedPaperIds.includes(paper.id)); state.candidates = state.candidates.filter(item => !removed.includes(item));
      if (state.loseNextCleanup) { state.loseNextCleanup = false; if (state.failReadAfterLost) { state.failReadAfterLost = false; state.failNextPapers = true; } return route.abort('connectionreset'); }
      return json(route, { schema_version: 't1-storage-cleanup-1', preview_id: input.preview_id, status: state.partial ? 'partial' : 'complete', already_executed: false,
        removed_bytes: removed.reduce((bytes, item) => bytes + item.bytes, 0), removed_files: removed.reduce((files, item) => files + item.files, 0), removed_paper_ids: removedPaperIds,
        results: selected.map(item => ({ id: item.id, status: removed.includes(item) ? 'removed' : 'protected', removed_bytes: removed.includes(item) ? item.bytes : 0, removed_files: removed.includes(item) ? item.files : 0, ...(!removed.includes(item) ? { error: 'storage_reference_changed' } : {}) })), summary: summary(state) });
    }
    if (method === 'POST' && path === base + '/papers') {
      state.uploads++; state.uploadRequests.push({ key: request.headers()['x-t1-request-id'], body: request.postDataBuffer().toString('utf8') }); const paper = { id: 'draft-paper', title: 'draft.pdf', filename: 'draft.pdf', sha256: 'b'.repeat(64), pages: 1, language: 'en', note: '', output_ids: [], uploaded: true }; state.papers.push(paper); return json(route, { paper, reused: false });
    }
    report.blocked.push({ name, path, method }); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => report.errors.push({ name, error: String(error) }));
  if (production) page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin && url.pathname.startsWith('/_next/static/')) report.next_static_resources.push({ name, path: url.pathname, status: response.status() }); });
  try {
    await page.goto(origin); await page.getByLabel('任务标题（可选）', { exact: true }).waitFor(); await page.evaluate(() => document.fonts.ready);
    if (clock) { await page.clock.install({ time: new Date('2026-11-15T00:00:00Z') }); await page.clock.pauseAt(new Date('2026-11-15T00:00:01Z')); }
    await work({ page, state }); report.checks.push({ name, status: 'passed' }); process.stdout.write('Passed: ' + name + '\n');
  } catch (error) { report.checks.push({ name, status: 'failed', error: error.stack ?? String(error) }); await screenshot(page, name + '-failed.png'); throw error; }
  finally { state.gate?.release(); await context.close(); }
}

try {
  await mkdir(evidence, { recursive: true });
  await scenario('desktop_selection_confirmation_bounds_focus_and_success', async ({ page, state }) => {
    await page.getByLabel('任务标题（可选）', { exact: true }).fill('保留我的创建任务草稿'); const before = await frame(page); await open(page);
    assert.deepEqual(await frame(page), before); await assertBounded(page);
    assert.equal(await panel(page).locator('input:checked').count(), 0); assert.equal(await review(page).isDisabled(), true); assert.equal(state.cleanups.length, 0);
    assert.equal(await panel(page).locator('[data-storage-stat="storageProtected"]').textContent(), '1 MiB');
    assert.ok(!(await panel(page).textContent()).includes('8.3 GiB'));
    await panel(page).getByText('哪些资料会保留', { exact: true }).click(); await panel(page).getByText('最近 24 小时上传', { exact: true }).waitFor();
    await screenshot(page, 'storage-desktop-preview.png');
    await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('button', { name: '存储管理', exact: true }).evaluate(element => element === document.activeElement), true);
    await open(page); await box(page, 'upload-1').check(); await box(page, 'parse-1').check(); await review(page).click();
    assert.equal(state.cleanups.length, 0); assert.equal(await panel(page).locator('[data-storage-confirm-id]').count(), 2);
    await panel(page).getByText('将永久删除以下无任务引用的文件，之后需要重新上传。删除后无法撤回。', { exact: true }).waitFor();
    await screenshot(page, 'storage-desktop-confirm.png');
    await panel(page).getByRole('button', { name: '返回选择', exact: true }).click(); assert.equal(await panel(page).locator('input:checked').count(), 2); await review(page).click();
    state.gate = gate(); await confirm(page).click(); await panel(page).getByRole('button', { name: '正在清理所选资料…', exact: true }).waitFor();
    await page.keyboard.press('Escape'); assert.equal(await panel(page).isVisible(), true);
    await page.locator('.t1-storage-footer .t1-primary').dispatchEvent('click'); assert.equal(state.cleanups.length, 1); state.gate.release(); state.gate = null;
    await page.locator('.t1-storage-toast').getByText('已清理 4 个文件 · 文件大小 8 KiB。', { exact: true }).waitFor();
    assert.deepEqual(state.cleanups[0], { preview_id: 'preview-2', version: 'version-2', candidate_ids: ['upload-1', 'parse-1'] });
    await box(page, 'parse-2').waitFor(); assert.equal(await box(page, 'upload-1').count(), 0); assert.equal(await panel(page).locator('input:checked').count(), 0); assert.ok(state.reads >= 2);
    assert.equal(await page.locator('.t1-storage-toast').evaluate(element => Boolean(element.closest('dialog[open]'))), true);
    const toast = await page.locator('.t1-storage-toast').boundingBox(); assert.ok(toast.x >= 0 && toast.y >= 0);
    assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '保留我的创建任务草稿'); assert.deepEqual(await frame(page), before);
    await screenshot(page, 'storage-desktop-success.png');
    await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'hidden' }); await page.locator('.t1-storage-toast').waitFor({ state: 'visible' });
    await page.clock.runFor(4100); await page.locator('.t1-storage-toast[data-leaving="true"]').waitFor(); await page.clock.resume(); await page.locator('.t1-storage-toast').waitFor({ state: 'detached' });
  }, { clock: true });
  await scenario('mobile_bounded_scroll_confirmation_and_partial_counts', async ({ page, state }) => {
    await page.getByLabel('任务标题（可选）', { exact: true }).fill('手机草稿'); await open(page); const before = await frame(page); await assertBounded(page);
    const checkboxes = panel(page).locator('input[type="checkbox"]'); await checkboxes.evaluateAll(elements => elements.forEach(input => input.click())); await review(page).click();
    assert.equal(state.cleanups.length, 0); assert.equal(await panel(page).locator('[data-storage-confirm-id]').count(), 28); await assertBounded(page); assert.deepEqual(await frame(page), before);
    await panel(page).locator('.t1-storage-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; }); await screenshot(page, 'storage-mobile-confirm-scroll.png');
    await panel(page).getByRole('button', { name: '返回选择', exact: true }).click();
    await checkboxes.evaluateAll(elements => elements.forEach(input => { if (input.checked) input.click(); })); await box(page, 'upload-1').check(); await box(page, 'parse-1').check(); await review(page).click();
    state.partial = true; await confirm(page).click(); await page.locator('.t1-storage-toast').getByText('部分清理完成：2 个文件 · 4 KiB，部分资料已保留。', { exact: true }).waitFor();
    await panel(page).getByText('发现新的任务引用，已保留', { exact: false }).waitFor();
    assert.equal(await box(page, 'upload-1').count(), 0); assert.equal(await box(page, 'parse-1').count(), 1); assert.equal(await panel(page).locator('input:checked').count(), 0); assert.equal(await review(page).isDisabled(), true);
    assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '手机草稿'); assert.deepEqual(await frame(page), before); await assertBounded(page); await screenshot(page, 'storage-mobile-partial.png');
    await page.clock.runFor(6100); await page.locator('.t1-storage-toast[data-leaving="true"]').waitFor(); await page.clock.resume(); await page.locator('.t1-storage-toast').waitFor({ state: 'detached' });
  }, { viewport: { width: 390, height: 844 }, clock: true });
  await scenario('stale_expired_busy_clear_selection_keep_upload_and_do_not_auto_retry', async ({ page, state }) => {
    await page.getByLabel('任务标题（可选）', { exact: true }).fill('保留标题与文件');
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles({ name: 'draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nfixture\n%%EOF\n') });
    await page.locator('[data-upload-state="uploaded"]').waitFor();
    const before = await frame(page);
    for (const [error, reason] of [['storage_preview_stale', '资料或任务引用已变化'], ['storage_preview_expired', '预览已过期'], ['storage_busy', '任务或文件操作正在执行']]) {
      await open(page); const id = state.candidates[0].id; await box(page, id).check(); await review(page).click(); state.cleanupError = error; const previous = state.cleanups.length; await confirm(page).click();
      await panel(page).locator('.t1-storage-problem').filter({ hasText: reason }).waitFor(); await panel(page).locator('input[type="checkbox"]').first().waitFor();
      assert.equal(state.cleanups.length, previous + 1); assert.equal(await panel(page).locator('input:checked').count(), 0); assert.equal(await review(page).isDisabled(), true);
      assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '保留标题与文件'); assert.equal(await page.locator('[data-upload-state="uploaded"]').count(), 1); assert.equal(state.uploads, 1); assert.deepEqual(await frame(page), before);
      if (error === 'storage_preview_stale') { assert.equal(await box(page, 'upload-1').count(), 0); await screenshot(page, 'storage-stale-preview.png'); }
      if (error === 'storage_busy') await screenshot(page, 'storage-busy.png');
      await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'hidden' });
    }
    assert.equal(state.cleanups.length, 3);
  });
  await scenario('empty_and_unavailable_preview_are_idle_and_read_failure_recovers', async ({ page, state }) => {
    state.candidates = []; await page.getByRole('button', { name: '存储管理', exact: true }).click(); await panel(page).getByText('当前没有可清理的资料。', { exact: true }).waitFor();
    assert.equal(await review(page).isDisabled(), true); assert.equal(await panel(page).locator('[aria-busy="true"]').count(), 0); assert.equal(state.cleanups.length, 0);
    state.busyPreview = true; await panel(page).getByRole('button', { name: '刷新预览', exact: true }).click(); await panel(page).getByText('任务或文件操作正在执行，暂不能清理，请结束后刷新。', { exact: true }).waitFor();
    assert.equal(await review(page).isDisabled(), true); assert.equal(await panel(page).locator('[aria-busy="true"]').count(), 0); assert.equal(state.cleanups.length, 0);
    await screenshot(page, 'storage-empty-protected.png');
    state.previewError = 'storage_scope_unavailable'; await panel(page).getByRole('button', { name: '刷新预览', exact: true }).click();
    await panel(page).locator('.t1-storage-problem').filter({ hasText: '部分资料暂时无法完整核验' }).waitFor();
    assert.equal(await review(page).isDisabled(), true); assert.equal(await panel(page).locator('input[type="checkbox"]').count(), 0);
    state.busyPreview = false; await panel(page).getByRole('button', { name: '刷新预览', exact: true }).click(); await panel(page).getByText('当前没有可清理的资料。', { exact: true }).waitFor();
    assert.equal(await panel(page).locator('.t1-storage-problem').count(), 0); assert.equal(state.cleanups.length, 0);
  });
  await scenario('cleaned_draft_keeps_file_title_scope_and_requires_explicit_reupload_with_new_key', async ({ page, state }) => {
    const content = '%PDF-1.4\npreserved original File bytes\n%%EOF\n';
    await page.getByLabel('任务标题（可选）', { exact: true }).fill('这份草稿保持不变');
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles({ name: 'draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from(content) });
    await page.locator('[data-upload-state="uploaded"]').waitFor();
    const savedScope = await page.locator('.t1-scope-card').textContent();
    for (const mode of ['known_result', 'lost_result', 'lost_result_and_failed_read']) {
      state.candidates = [{ ...candidate('draft-cleanup-' + mode, 'unused_upload'), name: 'draft.pdf', paper_ids: ['draft-paper'] }];
      const key = state.uploadRequests.at(-1).key, previousUploads = state.uploads;
      await open(page); await panel(page).locator('input[type="checkbox"]').check(); await review(page).click();
      state.loseNextCleanup = mode !== 'known_result'; state.failReadAfterLost = mode === 'lost_result_and_failed_read'; await confirm(page).click();
      await panel(page).getByText('当前没有可清理的资料。', { exact: true }).waitFor();
      if (mode === 'lost_result_and_failed_read') {
        await panel(page).locator('.t1-storage-problem').filter({ hasText: '资料列表核对失败' }).waitFor();
        assert.equal(await page.locator('[data-upload-state="uploadRemoved"]').count(), 0, 'A failed list read is not evidence of deletion');
        assert.equal(await page.locator('[data-upload-state="uploaded"]').count(), 1);
        await panel(page).getByRole('button', { name: '刷新预览', exact: true }).click();
      }
      await page.locator('[data-upload-state="uploadRemoved"]').waitFor({ state: 'attached' });
      assert.equal(await page.locator('[data-upload-state="uploaded"]').count(), 0); assert.equal(state.uploads, previousUploads, 'Cleanup never uploads automatically');
      assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '这份草稿保持不变'); assert.equal(await page.locator('.t1-scope-card').textContent(), savedScope);
      assert.equal(await page.locator('.t1-batch-file strong').textContent(), 'draft.pdf');
      await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'hidden' });
      if (mode === 'known_result') await screenshot(page, 'storage-draft-needs-reupload.png');
      await page.getByRole('button', { name: '重新上传', exact: true }).click(); await page.locator('[data-upload-state="uploaded"]').waitFor();
      assert.equal(state.uploads, previousUploads + 1); assert.notEqual(state.uploadRequests.at(-1).key, key); assert.equal(state.uploadRequests.at(-1).body, content);
      assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '这份草稿保持不变'); assert.equal(await page.locator('.t1-scope-card').textContent(), savedScope);
    }
    assert.equal(state.requests.filter(item => item.method === 'POST' && /\/runs$/.test(item.path)).length, 0);
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []);
  if (production) { assert.ok(report.next_static_resources.some(item => /\.js$/.test(item.path))); assert.ok(report.next_static_resources.every(item => item.status === 200)); }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await browser.close(); await writeFile(join(evidence, reportName), JSON.stringify(report, null, 2) + '\n'); }
if (report.status === 'failed') console.error(report.error);
