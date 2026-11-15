/** Actual React components in an isolated bundle. All requests are fulfilled in-browser; no server, model or production API is contacted. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), web = join(code, 'apps/pi-web');
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14');
const origin = 'http://127.0.0.1:30261';
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const { build } = await import(pathToFileURL(join(code, 'node_modules/esbuild/lib/main.js')).href);
const bundle = await build({
  absWorkingDir: web, tsconfig: join(web, 'tsconfig.json'), bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' },
  stdin: { resolveDir: web, sourcefile: 'auto-upload-toast-fixture.tsx', loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { flushSync } from 'react-dom';
    import { createRoot } from 'react-dom/client';
    import { I18nProvider } from './hooks/useI18n';
    import { BatchSubmission } from './t1/BatchSubmission';
    import { GlobalToasts } from './t1/GlobalToasts';
    const initialScope = { catalog_version: 'auto-upload-fixture', matching_policy_version: 'matching-fixture', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
    const catalog = { catalog: { catalog_version: initialScope.catalog_version, cancers: [], image_types: [], features: [], bindings: [] }, default_scope: initialScope, restricted_available: true, development_only: false };
    window.fixture = { events: [], resetSingle: false };
    function App() {
      const [scope, setScope] = useState(initialScope), [runs, setRuns] = useState([]), [revision, setRevision] = useState(0);
      const [notice, setNotice] = useState(null), [page, setPage] = useState('draft'), [ticks, setTicks] = useState(0), [failure, setFailure] = useState(false);
      Object.assign(window.fixture, { show: notice => flushSync(() => setNotice(notice)), rerender: () => setTicks(v => v + 1), fail: () => flushSync(() => { setFailure(true); setNotice({ text: '操作失败，请重试', failed: true }); }) });
      return <div className="t1-workbench">
        <header className="t1-topbar"><strong>T1 fixture</strong><span>导航</span></header>
        <GlobalToasts dismissLabel="关闭" items={notice ? [{ id: 'task', notice, onDismiss: () => setNotice(null), action: notice.failed ? <button className="t1-button" onClick={() => setNotice({ text: '已重试' })}>重试</button> : undefined }] : []} />
        <div className="t1-body"><main className="t1-main"><div className="t1-workspace-bar">上传及提示验证</div>
          <nav style={{ height: 34, flexShrink: 0 }}><button data-tab="draft" onClick={() => setPage('draft')}>创建任务</button><button data-tab="history" onClick={() => setPage('history')}>任务与历史</button></nav>
          <div className="t1-content-region"><div className="t1-content" data-view={page}>
            <div className="t1-new-task-panel" hidden={page !== 'draft'}><BatchSubmission key={revision} scope={scope} catalog={catalog} onScopeChange={setScope} canUpload canStart runs={runs} modelProfile={null} modelRequired={false}
              errorText={cause => cause instanceof Error ? cause.message : String(cause)} onUploaded={paper => window.fixture.events.push({ type: 'uploaded', id: paper.id })}
              onStarted={run => { window.fixture.events.push({ type: 'started', id: run.run_id }); setRuns(current => [...current, run]); }}
              onSingleStarted={run => { window.fixture.events.push({ type: 'single', id: run.run_id }); if (window.fixture.resetSingle) setRevision(v => v + 1); }}
              onBatchStarted={(runs, id) => window.fixture.events.push({ type: 'batch', id, runs: runs.map(run => run.run_id) })} onView={() => {}} /></div>
            {page === 'history' && <p data-history>任务与历史</p>}
            {failure && <div role="alert" data-persistent-error>操作失败<button data-persistent-retry onClick={() => setFailure(false)}>重试操作</button></div>}
            <output hidden data-ticks>{ticks}</output>
          </div></div>
        </main></div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<I18nProvider><App /></I18nProvider>);
  ` },
});
const css = await readFile(join(web, 't1/workbench.css'), 'utf8');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workbench.css"><style>*{box-sizing:border-box}body{margin:0}:root{--font-ui:Arial,sans-serif}button{font:inherit}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
const report = { status: 'running', method: 'Bundled actual BatchSubmission, GlobalToasts and CSS; all HTTP fulfilled by Playwright without a listening server.', checks: [], errors: [], blocked: [], paid_calls: 0, production_business_writes: 0 };
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const pdf = (name, body = name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n' + body + '\n%%EOF\n') });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function scenario(name, work, { mobile = false, reducedMotion = 'reduce', clock = false } = {}) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, reducedMotion });
  const state = { requests: [], papers: new Map(), uploadKeys: new Map(), startKeys: new Map(), lostOnce: new Set(), failedOnce: new Set(), startFailOnce: new Set(), uploadGate: null, uploadSeen: gate(), active: 0, maximum: 0 };
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await context.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { report.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
    if (method === 'GET' && path === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (method === 'GET' && path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (method === 'GET' && path === '/workbench.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (method === 'GET' && path === '/favicon.ico') return route.fulfill({ status: 204 });
    if (method === 'POST' && path === '/api/t1/workbench/papers') {
      const key = request.headers()['x-t1-request-id'], filename = decodeURIComponent(request.headers()['x-t1-filename']);
      state.requests.push({ op: 'upload', key, filename }); state.uploadSeen.resolve();
      state.active++; state.maximum = Math.max(state.active, state.maximum);
      if (state.uploadGate) await state.uploadGate.promise;
      const hash = createHash('sha256').update(request.postDataBuffer()).digest('hex');
      const reused = state.papers.has(hash);
      const paper = state.uploadKeys.get(key) ?? state.papers.get(hash) ?? { id: 'paper-' + (state.papers.size + 1), title: filename, sha256: hash, language: 'en', pages: 1, note: '', output_ids: [] };
      state.papers.set(hash, paper); state.uploadKeys.set(key, paper); state.active--;
      if (state.lostOnce.has(filename) && !state.failedOnce.has(filename)) { state.failedOnce.add(filename); return route.abort('connectionreset'); }
      return json(route, { paper, reused });
    }
    const paperId = path.match(/^\/api\/t1\/workbench\/papers\/([^/]+)\/runs$/)?.[1];
    if (method === 'POST' && paperId) {
      const key = request.headers()['x-t1-request-id'], body = request.postDataJSON();
      state.requests.push({ op: 'start', key, paperId, body });
      const filename = [...state.papers.values()].find(paper => paper.id === paperId)?.title;
      if (state.startFailOnce.delete(filename)) return json(route, { error: 'fixture_start_failed' }, 503);
      const run = state.startKeys.get(key) ?? { run_id: 'run-' + (state.startKeys.size + 1), document_id: paperId, state: 'queued', fixture: true, created_at: '2026-11-15T00:00:00Z', candidate_count: 0, submission: body.submission, scope: body.scope, task_title: body.task_title ?? filename };
      state.startKeys.set(key, run); return json(route, { run }, 201);
    }
    report.blocked.push({ path, method }); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => report.errors.push(String(error)));
  if (clock) {
    await page.clock.install({ time: new Date('2026-11-15T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-15T00:00:01Z'));
  }
  try {
    await page.goto(origin); await page.getByLabel('选择 PDF', { exact: true }).waitFor({ state: 'attached' });
    const batch = page.locator('.t1-batch'), idle = () => batch.locator(':scope[aria-busy="false"]').waitFor();
    await work({ page, state, batch, idle }); report.checks.push({ name, status: 'passed' }); process.stdout.write('Passed: ' + name + '\n');
  } catch (error) { report.checks.push({ name, status: 'failed', error: error.stack ?? String(error) }); throw error; }
  finally { state.uploadGate?.resolve(); await context.close(); }
}

try {
  await mkdir(evidence, { recursive: true });
  await scenario('selection_automatically_uploads_only_new_valid_content_sequentially_without_starting_extraction', async ({ page, state, batch, idle }) => {
    state.uploadGate = gate();
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles([pdf('same.pdf', 'AAA'), pdf('same.pdf', 'BBB'), pdf('renamed.pdf', 'AAA'), { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') }, { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) }]);
    await state.uploadSeen.promise;
    assert.equal(state.requests.length, 1); assert.equal(await batch.getByRole('button', { name: /上传待处理 PDF/ }).count(), 0);
    assert.equal(await batch.locator('.t1-batch-actions > .t1-primary').isDisabled(), true);
    await page.locator('[data-tab="history"]').click(); await page.locator('[data-history]').waitFor(); await page.locator('[data-tab="draft"]').click();
    state.uploadGate.resolve(); await idle(); state.uploadGate = null;
    assert.equal(state.maximum, 1); assert.equal(state.requests.filter(item => item.op === 'upload').length, 2); assert.equal(state.requests.filter(item => item.op === 'start').length, 0);
    assert.equal(await batch.locator('[data-upload-state="uploaded"]').count(), 2); assert.equal(await batch.locator('[data-upload-state="invalid"]').count(), 2);
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles([pdf('again.pdf', 'AAA'), pdf('third.pdf')]); await idle();
    assert.equal(state.requests.filter(item => item.op === 'upload').length, 3); assert.equal(state.requests.at(-1).filename, 'third.pdf');
    assert.equal(await batch.locator('[data-batch-member]').count(), 5);
  });
  await scenario('lost_upload_response_and_historical_reuse_keep_same_key_and_retry_only_the_failed_member', async ({ page, state, batch, idle }) => {
    state.lostOnce.add('retry.pdf');
    const historical = pdf('legacy.pdf', 'historical');
    state.papers.set(createHash('sha256').update(historical.buffer).digest('hex'), { id: 'historical-paper', title: '历史来源', output_ids: [] });
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles([pdf('ok.pdf'), pdf('retry.pdf'), historical]); await idle();
    assert.equal(await batch.locator('[data-upload-state="uploadFailed"]').count(), 1); assert.equal(await batch.locator('[data-upload-state="uploaded"]').count(), 2);
    const failedKey = state.requests.find(item => item.filename === 'retry.pdf').key, count = state.papers.size;
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles([pdf('alias-retry.pdf', 'retry.pdf'), pdf('alias-legacy.pdf', 'historical')]); await idle();
    assert.equal(state.requests.length, 3);
    await batch.getByRole('button', { name: '重试上传', exact: true }).click(); await idle();
    assert.equal(state.requests.length, 4); assert.equal(state.requests.at(-1).key, failedKey); assert.equal(state.papers.size, count);
    assert.equal(await batch.locator('[data-upload-state="uploaded"]').count(), 3); assert.equal(state.requests.filter(item => item.op === 'start').length, 0);
    assert.equal(await batch.getByText('已复用相同内容的 PDF 文件；开始后新建独立抽取任务。', { exact: true }).count(), 2);
  });
  await scenario('folder_selection_uploads_nested_pdfs_and_skips_other_files_and_duplicate_content', async ({ page, state, batch, idle }) => {
    await page.getByLabel('选择文件夹', { exact: true }).evaluate(input => {
      const data = new DataTransfer();
      for (const [name, body, path] of [['a.pdf', 'AAA', 'folder/a.pdf'], ['b.PDF', 'BBB', 'folder/nested/b.PDF'], ['alias.pdf', 'AAA', 'folder/alias.pdf'], ['notes.txt', 'notes', 'folder/notes.txt']]) {
        const file = new File(['%PDF-1.4\n' + body + '\n%%EOF\n'], name); Object.defineProperty(file, 'webkitRelativePath', { value: path }); data.items.add(file);
      }
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await idle(); assert.equal(state.requests.filter(item => item.op === 'upload').length, 2); assert.equal(state.requests.filter(item => item.op === 'start').length, 0);
    assert.equal(await batch.locator('[data-upload-state="uploaded"]').count(), 2); assert.ok((await batch.innerText()).includes('folder/nested/b.PDF'));
  });
  await scenario('batch_completion_waits_for_all_admissions_and_retry_preserves_batch_identity_scope_title_and_keys', async ({ page, state, batch, idle }) => {
    state.startFailOnce.add('second.pdf');
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles([pdf('first.pdf'), pdf('second.pdf')]); await idle();
    await page.getByLabel('任务标题（可选）', { exact: true }).fill('整批标题');
    await batch.locator('.t1-batch-actions > .t1-primary').click(); await idle();
    assert.equal(await batch.locator('[data-upload-state="submitted"]').count(), 1); assert.equal(await batch.locator('[data-upload-state="startFailed"]').count(), 1);
    assert.equal(await page.evaluate(() => window.fixture.events.filter(item => item.type === 'batch').length), 0);
    await batch.getByRole('button', { name: '重试提交抽取', exact: true }).click(); await idle();
    const starts = state.requests.filter(item => item.op === 'start'); assert.equal(starts.length, 3); assert.equal(starts[1].key, starts[2].key); assert.deepEqual(starts[1].body, starts[2].body); assert.equal(starts[2].body.task_title, '整批标题');
    const events = await page.evaluate(() => window.fixture.events); assert.equal(events.filter(item => item.type === 'single').length, 0);
    assert.deepEqual(events.find(item => item.type === 'batch'), { type: 'batch', id: starts[0].body.submission.batch_id, runs: ['run-1', 'run-2'] });
  });
  await scenario('single_admission_keeps_success_callback_and_keyed_form_reset', async ({ page, state, batch, idle }) => {
    await page.evaluate(() => { window.fixture.resetSingle = true; });
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(pdf('single.pdf')); await idle();
    assert.equal(state.requests.length, 1);
    await batch.getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).click();
    await page.waitForFunction(() => window.fixture.events.some(item => item.type === 'single'));
    assert.equal(await batch.locator('[data-batch-member]').count(), 0); assert.equal(state.requests.at(-1).body.submission.kind, 'single');
  });
  await scenario('toast_uses_four_and_six_second_timers_restarts_for_new_notice_survives_navigation_and_keeps_real_error', async ({ page }) => {
    const toast = page.locator('[data-toast-id="task"]');
    await page.evaluate(() => window.fixture.show({ text: '成功' })); await toast.waitFor();
    await page.clock.runFor(3000); await page.evaluate(() => window.fixture.rerender());
    await page.clock.runFor(999); assert.equal(await toast.getAttribute('data-leaving'), 'false');
    await page.clock.runFor(1); assert.equal(await toast.getAttribute('data-leaving'), 'true'); await page.clock.runFor(180); assert.equal(await toast.count(), 0);
    await page.evaluate(() => window.fixture.show({ text: '新提示' })); await toast.waitFor(); await page.clock.runFor(3500);
    await page.evaluate(() => window.fixture.show({ text: '新提示' })); await page.clock.runFor(500); assert.equal(await toast.getAttribute('data-leaving'), 'false');
    await page.locator('[data-tab="history"]').click(); assert.equal(await toast.innerText(), '✓\n新提示'); await page.clock.runFor(3500); await page.clock.runFor(180); assert.equal(await toast.count(), 0);
    await page.evaluate(() => window.fixture.show({ text: '处理中', busy: true })); await toast.waitFor(); await page.clock.runFor(12000); assert.equal(await toast.getAttribute('data-leaving'), 'false');
    await page.evaluate(() => window.fixture.show({ text: '已完成', busy: false })); await page.clock.runFor(4000); assert.equal(await toast.getAttribute('data-leaving'), 'true'); await page.clock.runFor(180); assert.equal(await toast.count(), 0);
    await page.evaluate(() => window.fixture.fail()); await toast.waitFor(); await page.clock.runFor(5999); assert.equal(await toast.getAttribute('data-leaving'), 'false');
    await page.clock.runFor(1); assert.equal(await toast.getAttribute('data-leaving'), 'true'); await page.clock.runFor(180); assert.equal(await toast.count(), 0); assert.equal(await page.locator('[data-persistent-error]').isVisible(), true); assert.equal(await page.locator('[data-persistent-retry]').isVisible(), true);
    await page.evaluate(() => window.fixture.show({ text: '减少动态效果' })); await toast.waitFor(); assert.equal(await toast.evaluate(node => getComputedStyle(node).animationName), 'none');
  }, { clock: true });
  await scenario('mobile_toast_is_centered_below_navigation_without_layout_shift_and_has_entrance_and_exit_animation', async ({ page }) => {
    const before = await page.locator('.t1-batch-actions').boundingBox();
    await page.evaluate(() => window.fixture.show({ text: '任务创建成功' })); const toast = page.locator('[data-toast-id="task"]'); await toast.waitFor();
    const rect = await toast.boundingBox(), nav = await page.locator('nav').boundingBox(), after = await page.locator('.t1-batch-actions').boundingBox();
    assert.deepEqual(after, before); assert.ok(rect && nav && rect.x >= 0 && rect.x + rect.width <= 390 && rect.y >= nav.y + nav.height && rect.y + rect.height < before.y);
    assert.ok(Math.abs(rect.x + rect.width / 2 - 195) < 1); assert.equal(await toast.evaluate(node => getComputedStyle(node).animationName), 't1-toast-in');
    await page.clock.runFor(4000); assert.equal(await toast.evaluate(node => getComputedStyle(node).animationName), 't1-toast-out'); await page.clock.runFor(180); assert.equal(await toast.count(), 0);
  }, { mobile: true, reducedMotion: 'no-preference', clock: true });
} finally {
  await browser.close(); report.status = report.checks.some(check => check.status === 'failed') || report.errors.length || report.blocked.length ? 'failed' : 'passed';
  await writeFile(join(evidence, 'auto-upload-toasts.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (report.status !== 'passed') process.exitCode = 1;
