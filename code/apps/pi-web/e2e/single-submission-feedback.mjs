/** Single-task creation feedback against in-browser fixtures. Every API is mocked; no model or business API is reached. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = process.env.T1_SUBMISSION_ORIGIN ?? 'http://127.0.0.1:30157';
const phase = process.env.T1_SUBMISSION_PHASE ?? 'after';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14');
const reportPath = join(evidence, 'report.json');
const result = { status: 'running', phase, origin, fixture_method: 'All /api routes fulfilled in Playwright; external traffic blocked.', checks: [], errors: [], blocked: [], observations: [], production_business_writes: 0, paid_calls: 0, exports_requested: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const scope = { catalog_version: 'submission-fixture-v1', matching_policy_version: 'matching-fixture-v1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
const profile = { profile_id: 'chosen-profile', provider: 'fixture', model_id: 'chosen-model', api: 'openai-responses', reasoning_effort: 'medium', context_window: 32768, max_output_tokens: 4096, configuration_source: 'server' };
const catalog = { catalog_version: scope.catalog_version, cancers: [{ id: 'lung', name: '肺癌' }], image_types: [{ id: 'ct', name: 'CT', cancer_ids: ['lung'] }], features: [], bindings: [], default_scope: scope, restricted_available: true, development_only: false };
const historical = { run_id: 'historical-newer', document_id: 'shared-paper', state: 'completed', fixture: true, candidate_count: 0, created_at: '2099-01-01T00:00:00Z', submission: { kind: 'single' }, task_title: '历史任务', model_id: 'chosen-model' };
const pdf = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic ' + name + '\n%%EOF\n') });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function save() {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.item4.single_submission_feedback ??= {};
  report.item4.single_submission_feedback[`browser_${phase}`] = result;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
async function scenario(name, work, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' });
  await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); localStorage.setItem('t1:extraction-model-profile', 'chosen-profile'); } }, origin);
  const state = { papers: [{ id: 'shared-paper', title: '论文来源名称', language: 'en', pages: 1, note: '', sha256: 'fixture-sha', output_ids: ['historical-newer'] }], runs: [historical], requests: [], startMode: 'success', startGate: null, startSeen: gate(), listGate: null, listSeen: gate(), nextState: 'queued' };
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { result.blocked.push({ method, path, reason: 'external' }); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(method)) { result.blocked.push({ method, path }); return route.abort('blockedbyclient'); }
      return route.continue();
    }
    const base = '/api/t1/workbench';
    if (method === 'GET' && path === base + '/capabilities') return json(route, { schema_version: 't1-workbench-capabilities-1', read_only: false, paper_upload: true, extraction_start: true, persisted_review: false, approved_export: false, model_selection: true, backend_pi_sdk: '1.4.0', max_concurrent_runs: 2 });
    if (method === 'GET' && path === base + '/catalog') return json(route, catalog);
    if (method === 'GET' && path === base + '/models') return json(route, { provider: 'fixture', default_profile_id: 'default-profile', profiles: [{ ...profile, profile_id: 'default-profile', model_id: 'default-model' }, profile] });
    if (method === 'GET' && path === base + '/papers') return json(route, { papers: state.papers });
    if (method === 'GET' && path === base + '/runs') {
      const snapshot = structuredClone(state.runs);
      if (state.listGate) { state.listSeen.resolve(); await state.listGate.promise; }
      return json(route, { runs: snapshot });
    }
    if (method === 'POST' && path === base + '/papers') {
      const filename = decodeURIComponent(request.headers()['x-t1-filename']);
      const paper = filename === 'second.pdf' ? { ...state.papers[0], id: 'second-paper', output_ids: [] } : state.papers[0];
      if (!state.papers.some(item => item.id === paper.id)) state.papers.push(paper);
      state.requests.push({ operation: 'upload', filename, key: request.headers()['x-t1-request-id'] });
      return json(route, { paper, reused: paper.id === 'shared-paper' });
    }
    const startPaper = path.match(/^\/api\/t1\/workbench\/papers\/([^/]+)\/runs$/)?.[1];
    if (method === 'POST' && startPaper) {
      const requestValue = { operation: 'start', paper: startPaper, key: request.headers()['x-t1-request-id'], body: request.postDataJSON() };
      state.requests.push(requestValue); state.startSeen.resolve();
      if (state.startGate) await state.startGate.promise;
      if (state.startMode === 'failure' || state.startMode === 'second-failure' && startPaper === 'second-paper') return json(route, { error: 'fixture_creation_failed' }, 503);
      if (state.startMode === 'network') return route.abort('connectionreset');
      if (state.startMode === 'unconfirmed') return json(route, { accepted: true }, 202);
      if (state.startMode === 'wrong-paper') return json(route, { run: { ...historical, run_id: 'incorrect-run', document_id: 'different-paper' } });
      const run = { ...historical, run_id: `created-${name}-${state.requests.filter(item => item.operation === 'start').length}`, document_id: startPaper, state: state.nextState, candidate_count: 0, created_at: '2026-11-15T00:00:00Z', submission: requestValue.body.submission, task_title: requestValue.body.task_title ?? requestValue.body.original_filename, original_filename: requestValue.body.original_filename, scope: requestValue.body.scope, model_profile: profile };
      state.runs.unshift(run); return json(route, { run }, 201);
    }
    if (method === 'GET' && path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture snapshot\n\n' });
    const runId = path.match(/^\/api\/t1\/workbench\/runs\/([^/]+)$/)?.[1];
    if (method === 'GET' && runId) {
      const run = state.runs.find(item => item.run_id === runId), paper = state.papers.find(item => item.id === run?.document_id);
      return run ? json(route, { run, paper, output: { id: runId, strategy: 'B0', state: run.state, origin: 'controlled_fixture', records: [] }, figures: [], source_units: [], source_issues: [], source_status: 'not_parsed', pdf_url: '', text_version: '', figure_catalog_sha256: null }) : json(route, { error: 'workbench_run_not_found' }, 404);
    }
    const paperId = path.match(/^\/api\/t1\/workbench\/papers\/([^/]+)$/)?.[1];
    if (method === 'GET' && paperId) return json(route, { paper: state.papers.find(item => item.id === paperId), outputs: [], figures: [], source_units: [], source_status: 'not_parsed', source_verified: false, pdf_url: '', text_version: '' });
    result.blocked.push({ method, path, reason: 'unknown_api' }); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => result.errors.push({ scenario: name, error: String(error) }));
  const batch = () => page.locator('.t1-batch');
  const starts = () => state.requests.filter(item => item.operation === 'start');
  async function ready(files = [pdf('single.pdf')], title = '新单篇标题') {
    await page.goto(origin + '/?paper=shared-paper&run=historical-newer&record=stale-record&view=newTask');
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(files);
    await page.waitForFunction(() => document.querySelector('.t1-batch')?.getAttribute('aria-busy') === 'false');
    await page.getByLabel('任务标题（可选）', { exact: true }).fill(title);
    await batch().getByRole('button', { name: /上传待处理 PDF/ }).click();
    await page.waitForFunction(() => document.querySelector('.t1-batch')?.getAttribute('aria-busy') === 'false');
  }
  async function start() { await batch().getByRole('button', { name: /^(开始单篇抽取|批量开始抽取)/ }).click(); }
  async function success() {
    await page.getByText('任务创建成功', { exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'records');
    const actual = new URL(page.url()).searchParams, run = state.runs[0];
    assert.equal(actual.get('run'), run.run_id); assert.equal(actual.get('paper'), run.document_id); assert.equal(actual.has('history'), false); assert.equal(actual.has('record'), false);
    await page.locator(`.t1-task-progress[data-state="${state.nextState}"]`).waitFor();
    if (await page.locator('.t1-sidebar').isVisible()) assert.equal(await page.locator(`[data-submission-list="sidebar"] [data-run-id="${run.run_id}"]`).getAttribute('aria-current'), 'page');
    return run;
  }
  async function cleanDraft() {
    await page.getByRole('tab', { name: '创建任务', exact: true }).click();
    assert.equal(await batch().locator('[data-batch-member]').count(), 0);
    assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '');
    assert.equal(await batch().locator('.t1-batch-scope,[data-saved-task-title],.t1-batch-error,.t1-notice').count(), 0);
    assert.equal(await batch().getByRole('button', { name: '选择文件', exact: true }).isEnabled(), true);
    assert.equal(await batch().getByRole('button', { name: '开始单篇抽取（0 篇）', exact: true }).isDisabled(), true);
    assert.deepEqual(await batch().locator('input[type="file"]').evaluateAll(inputs => inputs.map(input => input.files.length)), [0, 0]);
    assert.match(await batch().locator('.t1-model-choice').innerText(), /chosen-model/);
  }
  try {
    await work({ page, state, ready, start, starts, batch, success, cleanDraft });
    result.checks.push({ name, status: 'passed' }); console.log('PASS ' + name);
  } catch (error) {
    result.checks.push({ name, status: 'failed', error: String(error.stack ?? error) }); console.log('FAIL ' + name + '\n' + error);
    await page.screenshot({ path: join(evidence, `item4-submit-${phase}-failure.png`) }).catch(() => {});
  } finally { state.startGate?.resolve(); state.listGate?.resolve(); await context.close(); await save(); }
}

try {
  if (phase === 'before') {
    await scenario('existing_single_success_stays_on_filled_creation_page', async ({ page, ready, start, batch, starts }) => {
      await ready(); await start(); await batch().locator('[data-upload-state="submitted"]').waitFor();
      const observed = { view: new URL(page.url()).searchParams.get('view'), selected_files: await batch().locator('[data-batch-member]').count(), task_title: await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), success_toast_count: await page.getByText('任务创建成功', { exact: true }).count(), start_requests: starts().length };
      result.observations.push(observed); assert.deepEqual(observed, { view: 'newTask', selected_files: 1, task_title: '新单篇标题', success_toast_count: 0, start_requests: 1 });
      await page.screenshot({ path: join(evidence, 'item4-submit-before.png') });
    });
  } else {
    await scenario('single_success_opens_exact_returned_run_resets_draft_and_preserves_preferences', async ({ page, ready, start, success, cleanDraft, starts, batch }) => {
      await ready([pdf('single.pdf'), { name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') }]);
      await batch().getByRole('button', { name: '修改范围', exact: true }).click();
      await page.getByLabel('癌种', { exact: true }).selectOption('selected'); await page.getByLabel('肺癌', { exact: true }).check();
      await page.getByRole('button', { name: '确认范围', exact: true }).click();
      await start(); await success(); assert.equal(starts().length, 1); assert.equal(starts()[0].body.model_profile_id, profile.profile_id);
      await page.screenshot({ path: join(evidence, 'item4-submit-success-desktop.png') });
      await cleanDraft(); assert.match(await batch().locator('.t1-scope-compact').innerText(), /肺癌/);
      await page.screenshot({ path: join(evidence, 'item4-submit-reset-desktop.png') });
      await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(pdf('next.pdf')); await page.waitForFunction(() => document.querySelector('.t1-batch')?.getAttribute('aria-busy') === 'false');
      await batch().getByRole('button', { name: /上传待处理 PDF/ }).click(); await page.waitForFunction(() => document.querySelector('.t1-batch')?.getAttribute('aria-busy') === 'false');
      await start(); await success(); assert.equal(starts().length, 2); assert.notEqual(starts()[0].key, starts()[1].key); assert.equal(starts()[1].body.task_title, undefined); assert.deepEqual(starts()[1].body.scope.cancers, { mode: 'selected', ids: ['lung'] });
    });
    await scenario('mobile_success_toast_remains_visible_after_navigation_and_creation_resets', async ({ page, ready, start, success, cleanDraft, state }) => {
      state.nextState = 'parsing'; await ready(); await start(); await success();
      const toast = await page.getByText('任务创建成功', { exact: true }).boundingBox(); assert.ok(toast && toast.x >= 0 && toast.x + toast.width <= 390 && toast.y >= 0 && toast.y + toast.height <= 844);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(evidence, 'item4-submit-success-mobile.png') }); await cleanDraft();
    }, { width: 390, height: 844 });
    await scenario('pending_double_click_creates_once_and_only_confirmed_success_closes_drafts', async ({ page, ready, state, batch, starts, success, cleanDraft }) => {
      await ready(); state.startGate = gate();
      await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).evaluate(button => { button.click(); button.click(); });
      await state.startSeen.promise; assert.equal(starts().length, 1); assert.equal(await page.getByText('任务创建成功', { exact: true }).count(), 0); assert.equal(new URL(page.url()).searchParams.get('view'), 'newTask');
      assert.equal(await batch().getByRole('button', { name: '正在创建任务…', exact: true }).isDisabled(), true);
      await batch().getByRole('button', { name: '修改范围', exact: true }).click(); await page.getByLabel('癌种', { exact: true }).selectOption('selected');
      state.startGate.resolve(); await success(); assert.equal(await page.getByRole('dialog').count(), 0); await cleanDraft(); assert.match(await batch().locator('.t1-scope-compact').innerText(), /不限/);
    });
    for (const mode of ['failure', 'network', 'unconfirmed', 'wrong-paper']) await scenario(`${mode}_preserves_selection_and_request_identity_until_successful_retry`, async ({ page, ready, start, state, batch, starts, success, cleanDraft }) => {
      await ready(); state.startMode = mode; await start(); await batch().locator('[data-upload-state="startFailed"]').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('view'), 'newTask'); assert.equal(await page.getByText('任务创建成功', { exact: true }).count(), 0);
      assert.equal(await batch().locator('[data-batch-member]').count(), 1); assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '新单篇标题');
      assert.ok((await batch().locator('.t1-batch-error').innerText()).length > 0);
      state.startMode = 'success'; await batch().getByRole('button', { name: '重试提交抽取', exact: true }).click(); await success();
      assert.equal(starts().length, 2); assert.equal(starts()[0].key, starts()[1].key); assert.deepEqual(starts()[0].body, starts()[1].body); await cleanDraft();
    });
    await scenario('older_inflight_list_cannot_remove_newly_created_run', async ({ page, ready, start, state, starts, success }) => {
      await ready(); state.startGate = gate(); await start(); await state.startSeen.promise;
      state.listGate = gate(); await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await state.listSeen.promise;
      state.startGate.resolve(); const run = await success(); state.listGate.resolve();
      await page.getByText('已更新论文列表、任务状态与当前结果。', { exact: true }).waitFor();
      assert.equal(starts().length, 1); assert.equal(await page.locator(`[data-submission-list="sidebar"] [data-run-id="${run.run_id}"]`).getAttribute('aria-current'), 'page'); assert.equal(new URL(page.url()).searchParams.get('run'), run.run_id);
    });
    await scenario('batch_partial_failure_and_last_member_retry_keep_existing_batch_behavior', async ({ page, ready, start, state, batch, starts }) => {
      await ready([pdf('single.pdf'), pdf('second.pdf')], '批量标题'); state.startMode = 'second-failure'; await start();
      await batch().locator('[data-upload-state="startFailed"]').waitFor(); assert.equal(await batch().locator('[data-upload-state="submitted"]').count(), 1); assert.equal(await batch().locator('[data-batch-member]').count(), 2); assert.equal(await page.getByText('任务创建成功', { exact: true }).count(), 0); assert.equal(new URL(page.url()).searchParams.get('view'), 'newTask');
      state.startMode = 'success'; await batch().getByRole('button', { name: '重试提交抽取', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('[data-upload-state="submitted"]').length === 2);
      assert.equal(starts().length, 3); assert.equal(starts()[1].key, starts()[2].key); assert.deepEqual(starts()[1].body, starts()[2].body); assert.equal(starts()[2].body.submission.kind, 'batch'); assert.equal(await batch().locator('[data-batch-member]').count(), 2); assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '批量标题'); assert.equal(new URL(page.url()).searchParams.get('view'), 'newTask');
    });
  }
} finally {
  await browser.close(); result.status = result.checks.some(check => check.status === 'failed') || result.errors.length || result.blocked.length ? 'failed' : 'passed'; await save();
}
if (result.status !== 'passed') process.exitCode = 1;
