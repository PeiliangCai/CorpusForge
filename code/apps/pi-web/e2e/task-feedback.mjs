/** One validated production build; every API request is fulfilled in-browser, with no model or business writes. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = process.env.T1_FEEDBACK_ORIGIN ?? 'http://127.0.0.1:30157', phase = process.env.T1_FEEDBACK_PHASE ?? 'after';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14');
const dist = phase === 'before' ? 'apps/pi-web/build/single-submit-feedback-validated-20261115' : (process.env.T1_FEEDBACK_DIST ?? 'apps/pi-web/build/task-feedback-delivery-validated-20261115');
const BUILD_ID = (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim();
const reportPath = join(evidence, 'report.json');
const result = { status: 'running', phase, origin, dist, BUILD_ID, checks: [], errors: [], blocked: [], observations: [], production_business_writes: 0, paid_calls: 0, production_exports: 0, mock_requests: [] };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const batchA = '11111111-1111-4111-8111-111111111111', batchB = '22222222-2222-4222-8222-222222222222';
const scope = { catalog_version: 'task-feedback-fixture', matching_policy_version: 'fixture', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
const profile = { profile_id: 'chosen-profile', provider: 'fixture', model_id: 'chosen-model', api: 'openai-responses', reasoning_effort: 'medium', context_window: 32768, max_output_tokens: 4096, configuration_source: 'server' };
const catalog = { catalog_version: scope.catalog_version, cancers: [{ id: 'lung', name: '肺癌' }], image_types: [{ id: 'ct', name: 'CT', cancer_ids: ['lung'] }], features: [], bindings: [], default_scope: scope, restricted_available: true, development_only: false };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b3sAAAAASUVORK5CYII=', 'base64');
const originalPdf = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf'));
const fragment = (text, run, page = 1) => ({ block_id: run + '-block', text_version: run + '-text', start: 0, end: text.length, exact_quote: text, occurrence: 1, physical_page: page, bbox: [0, 0, 10, 10], location_precision: 'block' });
const record = (id, run, text) => ({ id, run_id: run, version: 1, fragments: [fragment(text, run)], context: [], association: 'paired', figure_ids: ['same-figure'], proposed_figure_ids: [], reasons: [], review_status: 'pending', text_fingerprint: run, delivery_fingerprint: run, evidence_role: 'primary_candidate', retention: { status: 'kept', revision: 0, origin: 'default', record_version: 1 } });
const file = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic ' + name + '\n%%EOF\n') });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function seed() {
  const paper = i => ({ id: 'paper-' + i, title: '来源论文 ' + i, filename: 'source-' + i + '.pdf', sha256: String(i + 1).repeat(64), language: 'en', pages: 1, note: '', uploaded: true, output_ids: [] });
  const single = (id, document, completion, state = 'partial') => ({ run_id: id, document_id: 'paper-' + document, state, fixture: false, candidate_count: 1, created_at: '2026-11-15T00:00:00Z', model_id: profile.model_id, model_profile: profile, scope, task_title: id, original_filename: 'source-' + document + '.pdf', submission: { kind: 'single' }, result_ready: !['queued', 'parsing', 'extracting', 'reconciling'].includes(state), ...(completion === undefined ? {} : { task_processing_complete: completion }) });
  const runs = [single('single-unknown', 0, undefined), single('single-false', 1, false), single('single-true', 2, true), single('single-active', 3, undefined, 'parsing'), { ...single('member-a', 0, false), submission: { kind: 'batch', batch_id: batchA }, task_title: '统一批量任务' }, { ...single('member-b', 1, true), submission: { kind: 'batch', batch_id: batchA }, task_title: '统一批量任务' }, { ...single('other-member', 0, true), submission: { kind: 'batch', batch_id: batchB }, task_title: '另一次批量提交' }, { ...single('legacy-one', 0, undefined), submission: undefined }, { ...single('legacy-two', 0, undefined), submission: undefined }];
  const records = Object.fromEntries(runs.map(run => [run.run_id, [record(run.run_id.startsWith('member-') ? 'same-record-id' : run.run_id + '-record', run.run_id, 'ONLY ' + run.run_id + ' verbatim source')]]));
  const papers = [0, 1, 2, 3].map(paper); for (const p of papers) p.output_ids = runs.filter(run => run.document_id === p.id).map(run => run.run_id);
  return { papers, runs, records, requests: [], failing: '', hold: '', held: null, seen: gate(), missingSource: '', startFailure: '', created: 0 };
}
async function save() { const report = JSON.parse(await readFile(reportPath, 'utf8')); report.item4.feedback_20261115 ??= {}; report.item4.feedback_20261115['browser_' + phase] = result; await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
async function scenario(name, work, viewport = { width: 1440, height: 1000 }) {
  if (process.env.T1_FEEDBACK_CASES && !process.env.T1_FEEDBACK_CASES.split(',').includes(name)) return;
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce', acceptDownloads: true });
  await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); localStorage.setItem('t1:extraction-model-profile', 'chosen-profile'); } }, origin);
  const state = seed(), json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  function detail(run) {
    const paper = state.papers.find(paper => paper.id === run.document_id);
    const output = { id: run.run_id, strategy: 'B0', state: run.state, origin: 'workbench_run', records: state.records[run.run_id] ?? [], coverage: { ...(run.task_processing_complete === undefined ? {} : { task_processing_complete: run.task_processing_complete }) }, scope };
    return { run, paper, output, pdf_url: '/api/t1/workbench/papers/' + paper.id + '/pdf', text_version: run.run_id + '-text', source_units: [], source_issues: state.missingSource === run.run_id ? ['pdf_source_file_missing'] : [], source_status: state.missingSource === run.run_id ? 'missing' : 'valid', figure_catalog_sha256: run.run_id + '-catalog', figures: [{ id: 'same-figure', number: '1', verification: 'needs_review', caption: [fragment('ONLY ' + run.run_id + ' caption', run.run_id)], assets: [{ id: 'same-asset', url: '/api/t1/workbench/runs/' + run.run_id + '/figures/same-asset', sha256: run.run_id + '-asset', page: 1, width: 100, height: 100 }] }] };
  }
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { result.blocked.push({ method, path, reason: 'external' }); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    const base = '/api/t1/workbench';
    if (method === 'GET' && path === base + '/capabilities') return json(route, { schema_version: 't1-workbench-capabilities-1', read_only: false, paper_upload: true, extraction_start: true, persisted_review: true, persisted_retention: true, retained_export: true, model_selection: true, approved_export: false, backend_pi_sdk: '1.4.0', max_concurrent_runs: 2 });
    if (method === 'GET' && path === base + '/catalog') return json(route, catalog);
    if (method === 'GET' && path === base + '/models') return json(route, { provider: 'fixture', default_profile_id: profile.profile_id, profiles: [profile] });
    if (method === 'GET' && path === base + '/papers') return json(route, { papers: state.papers });
    if (method === 'GET' && path === base + '/runs') return json(route, { runs: state.runs });
    if (method === 'GET' && path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture snapshot\n\n' });
    if (method === 'GET' && /\/figures\/same-asset$/.test(path)) return route.fulfill({ contentType: 'image/png', body: png });
    if (method === 'GET' && path.endsWith('/pdf')) return route.fulfill({ contentType: 'application/pdf', body: originalPdf });
    const runId = path.match(/^\/api\/t1\/workbench\/runs\/([^/]+)$/)?.[1];
    if (method === 'GET' && runId) {
      if (runId === state.hold) { state.seen.resolve(); await state.held.promise; }
      if (runId === state.failing) return json(route, { error: 'fixture_exact_member_unavailable' }, 503);
      const run = state.runs.find(run => run.run_id === runId); return run ? json(route, detail(run)) : json(route, { error: 'workbench_run_not_found' }, 404);
    }
    const paperId = path.match(/^\/api\/t1\/workbench\/papers\/([^/]+)$/)?.[1];
    if (method === 'GET' && paperId) {
      const paper = state.papers.find(paper => paper.id === paperId), peers = state.runs.filter(run => run.document_id === paperId);
      return json(route, { paper, outputs: peers.map(run => detail(run).output), figures: [], pdf_url: '/api/t1/workbench/papers/' + paperId + '/pdf', source_verified: false, source_status: 'not_parsed', source_units: [], text_version: 'LATEST-PAPER-UNUSABLE' });
    }
    const retain = path.match(/^\/api\/t1\/workbench\/runs\/([^/]+)\/records\/([^/]+)\/retention$/);
    if (method === 'POST' && retain) {
      const item = state.records[retain[1]].find(item => item.id === retain[2]), input = request.postDataJSON(); state.requests.push({ method, path, input });
      item.retention = { ...item.retention, status: input.status, origin: 'user', revision: item.retention.revision + 1 }; return json(route, { record: item });
    }
    const batchDelete = path.match(/^\/api\/t1\/workbench\/batches\/([^/]+)$/);
    if (method === 'DELETE' && (batchDelete || runId)) {
      state.requests.push({ method, path }); const ids = batchDelete ? state.runs.filter(run => run.submission?.kind === 'batch' && run.submission.batch_id === batchDelete[1]).map(run => run.run_id) : [runId];
      state.runs = state.runs.filter(run => !ids.includes(run.run_id)); return json(route, { deleted: true, run_ids: ids });
    }
    const cancel = path.match(/^\/api\/t1\/workbench\/(batches|runs)\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancel) {
      state.requests.push({ method, path }); const members = cancel[1] === 'batches' ? state.runs.filter(run => run.submission?.kind === 'batch' && run.submission.batch_id === cancel[2]) : state.runs.filter(run => run.run_id === cancel[2]);
      for (const run of members) if (['queued', 'parsing', 'extracting', 'reconciling'].includes(run.state)) { run.state = 'cancelled'; run.result_ready = true; }
      return json(route, cancel[1] === 'batches' ? { runs: members } : { run: members[0] });
    }
    if (method === 'GET' && path.includes('/exports/')) { state.requests.push({ method, path }); return route.fulfill({ contentType: 'application/gzip', body: Buffer.from('fixture package') }); }
    if (method === 'PUT' && path.endsWith('/pdf')) { state.requests.push({ method, path }); state.missingSource = ''; return json(route, { restored: true }); }
    if (method === 'POST' && path === base + '/papers') {
      const filename = decodeURIComponent(request.headers()['x-t1-filename']); let paper = state.papers.find(paper => paper.filename === filename);
      if (!paper) { paper = { ...state.papers[0], id: 'uploaded-' + filename.replace(/\.pdf$/, ''), filename, output_ids: [] }; state.papers.push(paper); }
      state.requests.push({ method, path, filename, key: request.headers()['x-t1-request-id'] }); return json(route, { paper, reused: false }, 201);
    }
    const start = path.match(/^\/api\/t1\/workbench\/papers\/([^/]+)\/runs$/);
    if (method === 'POST' && start) {
      const body = request.postDataJSON(); state.requests.push({ method, path, key: request.headers()['x-t1-request-id'], body });
      if (state.startFailure === start[1] || state.startFailure === 'all') return json(route, { error: 'fixture_create_failed' }, 503);
      const run = { ...state.runs[0], run_id: 'created-' + ++state.created, document_id: start[1], state: 'queued', candidate_count: 0, result_ready: false, submission: body.submission, task_title: body.task_title ?? body.original_filename, original_filename: body.original_filename, task_processing_complete: undefined, scope: body.scope, model_profile: profile };
      state.runs.unshift(run); state.records[run.run_id] = []; return json(route, { run }, 202);
    }
    result.blocked.push({ method, path, reason: 'unknown_api' }); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on('pageerror', error => result.errors.push({ name, error: String(error) }));
  const go = async (run = 'member-a', view = 'records') => { const item = state.runs.find(item => item.run_id === run); await page.goto(origin + '/?' + new URLSearchParams({ paper: item?.document_id ?? 'paper-0', run, view })); await page.locator('.t1-results-heading, .t1-new-task-panel:not([hidden])').first().waitFor(); };
  try { await work({ page, context, state, go, detail }); result.checks.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { result.checks.push({ name, status: 'failed', error: String(error) }); console.log('FAIL ' + name + '\n' + error); try { await page.screenshot({ path: join(evidence, 'feedback-failed-' + name + '.png') }); } catch {} }
  finally { state.held?.resolve(); result.mock_requests.push(...state.requests.map(request => ({ scenario: name, ...request }))); await context.close(); await save(); }
}
const sidebar = page => page.locator('[data-submission-list="sidebar"]');
const selectedCard = page => page.locator('.t1-evidence-card');
const status = (page, id) => sidebar(page).locator(`[data-run-row="${id}"] .t1-run-state`).innerText();
const choose = async (page, id) => { await sidebar(page).locator(`[data-run-id="${id}"]`).click(); await selectedCard(page).waitFor(); };
try {
  assert.equal((await fetch(origin + '/_next/static/' + BUILD_ID + '/_buildManifest.js')).status, 200);
  await scenario('selection_stable_completion_three_states', async ({ page, go }) => {
    await go('single-true'); await selectedCard(page).waitFor(); const before = await status(page, 'single-true');
    await choose(page, 'single-false'); const after = await status(page, 'single-true');
    result.observations.push({ before_selected_true: before, after_selecting_other: after });
    if (phase === 'before') { assert.notEqual(before, after); return; }
    assert.equal(before, after); assert.match(before, /任务处理完成/);
    for (const id of ['single-unknown', 'single-true', 'single-false']) { await choose(page, id); assert.match(await status(page, 'single-unknown'), /待核/); assert.match(await status(page, 'single-false'), /任务处理未完成/); assert.match(await status(page, 'single-true'), /任务处理完成/); }
  });
  if (phase !== 'before') {
    await scenario('delivery_display_details', async ({ page, state, go }) => {
      await go('member-b'); await page.waitForFunction(() => document.querySelector('[data-retention-count="kept"]')?.textContent === '2');
      assert.ok(!(await page.locator('.t1-batch-overview > p').nth(1).innerText()).trim().endsWith('·'));
      await page.locator('[data-index-run-id="member-b"]').click();
      await page.screenshot({ path: join(evidence, 'feedback-batch-desktop.png') });
      await sidebar(page).locator('[data-task-menu-id="batch:' + batchA + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click();
      await page.locator('dialog[open]').waitFor(); assert.equal(await page.locator('.t1-delete-target code').innerText(), batchA);
      await page.screenshot({ path: join(evidence, 'feedback-batch-delete-desktop.png') });
      await page.getByRole('button', { name: '保留任务', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.t1-sidebar').waitFor({ state: 'hidden' });
      await page.screenshot({ path: join(evidence, 'feedback-batch-mobile.png') });
      await page.locator('.t1-workspace-bar > button').first().click(); await sidebar(page).waitFor();
      await page.screenshot({ path: join(evidence, 'feedback-batch-sidebar-mobile.png') });
      await sidebar(page).locator('[data-task-menu-id="batch:' + batchA + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click();
      await page.locator('dialog[open]').waitFor(); assert.equal(await page.locator('.t1-delete-target code').innerText(), batchA);
      await page.screenshot({ path: join(evidence, 'feedback-batch-delete-mobile.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.getByRole('button', { name: '确认删除任务', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      const params = new URL(page.url()).searchParams, fallback = state.runs.find(run => run.run_id === params.get('run')); assert.ok(fallback); assert.equal(params.get('paper'), fallback.document_id);
      assert.ok((await page.locator('[data-toast-id="refresh"]').innerText()).includes(batchA.slice(-8)));
    });
    await scenario('batch_one_task_unified_results_and_exact_record_sources', async ({ page, state, go }) => {
      await go(); await page.waitForFunction(() => document.querySelector('[data-retention-count="kept"]')?.textContent === '2');
      assert.equal(await sidebar(page).locator('[data-submission-group]').count(), 8); assert.equal(await sidebar(page).locator('[data-submission-group="batch:' + batchA + '"] [data-run-id]').count(), 1);
      assert.match(await sidebar(page).locator('[data-submission-group="batch:' + batchA + '"]').innerText(), /批量/);
      assert.equal(await page.locator('.t1-index-list button').count(), 2); assert.equal(await page.locator('[data-index-record-id="same-record-id"]').count(), 2);
      await page.locator('[data-index-run-id="member-b"]').click(); await page.waitForFunction(() => document.querySelector('.t1-evidence-card')?.getAttribute('data-source-run-id') === 'member-b');
      assert.equal(await selectedCard(page).getAttribute('data-source-paper-id'), 'paper-1'); assert.match(await page.locator('.t1-record-provenance').innerText(), /source-1.pdf/);
      assert.equal(await page.locator('.t1-quote-frame .t1-verbatim').innerText(), 'ONLY member-b verbatim source'); assert.ok((await page.locator('.t1-figure img').getAttribute('src')).includes('/runs/member-b/figures/'));
      await page.locator('[data-retention-action]').click(); await page.waitForFunction(() => document.querySelector('[data-retention-count="excluded"]')?.textContent === '1');
      assert.equal(state.records['member-b'][0].retention.status, 'excluded'); assert.equal(state.records['member-a'][0].retention.status, 'kept'); assert.equal(state.records['single-unknown'][0].retention.status, 'kept');
      assert.ok(state.requests.some(request => request.path.includes('/runs/member-b/records/same-record-id/retention')));
      await page.screenshot({ path: join(evidence, 'feedback-batch-desktop.png') });
      await page.getByRole('tab').filter({ hasText: '任务与历史' }).click(); assert.equal(await page.locator('[data-submission-list="history"] [data-submission-group]').count(), 8);
    });
    await scenario('batch_export_and_delete_confirm_entire_submission', async ({ page, state, go }) => {
      await go(); await page.waitForFunction(() => document.querySelector('[data-retention-count="kept"]')?.textContent === '2');
      await page.locator('.t1-exports summary').click(); assert.equal(await page.locator('.t1-export-options button').count(), 1);
      await page.locator('.t1-export-options button').click(); await page.waitForFunction(() => !document.querySelector('.t1-sr-only')?.textContent?.includes('下载'));
      assert.ok(state.requests.some(request => request.path === '/api/t1/workbench/batches/' + batchA + '/exports/retained_package'));
      await sidebar(page).locator('[data-task-menu-id="batch:' + batchA + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click();
      await page.locator('dialog[open]').waitFor(); assert.match(await page.locator('[data-delete-batch]').innerText(), /2/); assert.equal(await page.locator('.t1-delete-members li').count(), 2);
      await page.screenshot({ path: join(evidence, 'feedback-batch-delete-desktop.png') });
      await page.getByRole('button', { name: '确认删除任务', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      assert.ok(!state.runs.some(run => ['member-a', 'member-b'].includes(run.run_id))); assert.ok(state.runs.some(run => run.run_id === 'single-unknown')); assert.ok(state.runs.some(run => run.run_id === 'other-member'));
      assert.equal(await sidebar(page).locator('[data-submission-group="batch:' + batchA + '"]').count(), 0); assert.equal(state.requests.filter(request => request.method === 'DELETE').length, 1);
    });
    await scenario('batch_active_members_cancel_together_and_deletion_is_blocked', async ({ page, state, go }) => {
      state.runs.find(run => run.run_id === 'member-b').state = 'extracting'; state.runs.find(run => run.run_id === 'member-b').result_ready = false;
      await go(); await page.locator('[data-batch-results]').waitFor(); assert.match(await sidebar(page).locator('[data-submission-group="batch:' + batchA + '"]').innerText(), /批量任务处理中/);
      await sidebar(page).locator('[data-task-menu-id="batch:' + batchA + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click(); assert.equal(await page.getByRole('button', { name: '确认删除任务' }).isDisabled(), true);
      await page.getByRole('button', { name: '保留任务', exact: true }).click();
      await sidebar(page).locator('[data-task-menu-id="batch:' + batchA + '"]').click(); await page.getByRole('menuitem', { name: '取消整个批量任务' }).click();
      await page.locator('[data-toast-id="task"]').filter({ hasText: '已取消' }).waitFor(); assert.equal(state.runs.find(run => run.run_id === 'member-b').state, 'cancelled');
      assert.equal(state.runs.find(run => run.run_id === 'single-active').state, 'parsing'); assert.equal(state.requests.filter(request => request.path.includes('/cancel')).length, 1); assert.ok(state.requests[0].path.includes('/batches/' + batchA + '/cancel'));
    });
    await scenario('late_and_failed_member_details_never_borrow_other_submissions', async ({ page, state, go }) => {
      state.hold = 'member-b'; state.held = gate(); await go(); await state.seen.promise;
      await choose(page, 'single-true'); state.held.resolve(); await page.waitForFunction(() => document.querySelector('.t1-evidence-card')?.getAttribute('data-source-run-id') === 'single-true');
      assert.equal(await page.locator('[data-retention-count="kept"]').innerText(), '1'); assert.ok(!(await page.locator('.t1-quote-frame').innerText()).includes('member'));
      state.hold = ''; state.failing = 'member-b'; await go(); await page.getByRole('alert').filter({ hasText: 'fixture_exact_member_unavailable' }).waitFor();
      assert.equal(await page.locator('[data-index-run-id="member-b"]').count(), 0); assert.equal(await page.locator('[data-index-run-id="other-member"]').count(), 0); assert.equal(await page.locator('[data-index-run-id="single-unknown"]').count(), 0);
    });
    await scenario('batch_restore_targets_record_paper_and_figure_directory_names_source', async ({ page, state, go }) => {
      state.missingSource = 'member-b'; await go(); await page.locator('[data-index-run-id="member-b"]').click(); await page.getByLabel('选择待恢复的同一原 PDF').setInputFiles(file('source-1.pdf'));
      await page.getByRole('button', { name: '恢复同一原 PDF', exact: true }).click();
      assert.ok(state.requests.some(request => request.method === 'PUT' && request.path === '/api/t1/workbench/papers/paper-1/pdf'));
      await page.getByRole('tab').filter({ hasText: 'Figure' }).click(); assert.match(await page.locator('.t1-record-provenance').innerText(), /source-1.pdf/); assert.ok((await page.locator('.t1-figure img').getAttribute('src')).includes('/runs/member-b/figures/'));
    });
    await scenario('single_auto_upload_success_resets_form_and_failure_retries_same_identity', async ({ page, state, go }) => {
      await go('single-true', 'newTask'); await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(file('new-single.pdf'));
      await page.waitForFunction(() => document.querySelector('.t1-batch')?.getAttribute('aria-busy') === 'false'); assert.equal(await page.getByRole('button', { name: /上传待处理/ }).count(), 0);
      await page.getByLabel('任务标题（可选）', { exact: true }).fill('单篇新任务'); state.startFailure = 'all'; await page.getByRole('button', { name: /^开始单篇抽取/ }).click();
      await page.getByText('fixture_create_failed', { exact: false }).first().waitFor(); const first = state.requests.find(request => request.body?.submission?.kind === 'single');
      assert.equal(await page.locator('.t1-batch [data-batch-member]').count(), 1); state.startFailure = ''; await page.getByRole('button', { name: /^开始单篇抽取/ }).click();
      await page.locator('[data-toast-id="task"]').filter({ hasText: '任务创建成功' }).waitFor(); assert.equal(new URL(page.url()).searchParams.get('run'), 'created-1');
      const starts = state.requests.filter(request => request.body?.submission?.kind === 'single'); assert.equal(starts.length, 2); assert.equal(starts[0].key, starts[1].key); assert.deepEqual(starts[1].body.scope, scope); assert.equal(starts[1].body.model_profile_id, profile.profile_id); assert.ok(first);
      await page.locator('.t1-new-task').click(); assert.equal(await page.locator('.t1-batch [data-batch-member]').count(), 0); assert.equal(await page.getByLabel('任务标题（可选）', { exact: true }).inputValue(), '');
      await page.locator('[data-toast-id="task"]').waitFor({ state: 'hidden', timeout: 6000 });
    });
    await scenario('batch_partial_admission_preserves_retry_then_opens_combined_task', async ({ page, state, go }) => {
      await go('single-true', 'newTask'); await page.getByLabel('选择 PDF', { exact: true }).setInputFiles([file('new-a.pdf'), file('new-b.pdf')]);
      await page.waitForFunction(() => document.querySelector('.t1-batch')?.getAttribute('aria-busy') === 'false'); state.startFailure = 'uploaded-new-b';
      await page.getByRole('button', { name: /^批量开始抽取/ }).click(); await page.getByText('fixture_create_failed', { exact: false }).first().waitFor();
      assert.equal(new URL(page.url()).searchParams.get('view'), 'newTask'); assert.equal(await page.locator('[data-toast-id="task"]').count(), 0); const original = state.requests.find(request => request.body?.original_filename === 'new-b.pdf');
      state.startFailure = ''; await page.getByRole('button', { name: /^批量开始抽取/ }).click();
      await page.locator('[data-toast-id="task"]').filter({ hasText: '批量任务创建成功' }).waitFor(); await page.locator('[data-batch-results]').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('view'), 'records'); const retries = state.requests.filter(request => request.body?.original_filename === 'new-b.pdf'); assert.equal(retries[1].key, original.key); assert.equal(retries[1].body.submission.batch_id, original.body.submission.batch_id);
      const group = sidebar(page).locator('[data-submission-group="batch:' + original.body.submission.batch_id + '"]'); assert.equal(await group.locator('[data-run-id]').count(), 1); assert.match(await group.innerText(), /2/);
      await page.locator('.t1-new-task').click(); assert.equal(await page.locator('.t1-batch [data-batch-member]').count(), 0);
    });
    await scenario('mobile_390_batch_results_sidebar_and_delete_dialog_fit', async ({ page, go }) => {
      await go(); await page.waitForFunction(() => document.querySelector('[data-retention-count="kept"]')?.textContent === '2'); await page.locator('.t1-record-selector select').selectOption(JSON.stringify(['member-b', 'same-record-id']));
      await page.screenshot({ path: join(evidence, 'feedback-batch-mobile.png') });
      await page.locator('.t1-workspace-bar > button').first().click(); await sidebar(page).waitFor(); await page.screenshot({ path: join(evidence, 'feedback-batch-sidebar-mobile.png') });
      await sidebar(page).locator('[data-task-menu-id="batch:' + batchA + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click();
      await page.locator('dialog[open]').waitFor(); const box = await page.locator('dialog[open]').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391); await page.screenshot({ path: join(evidence, 'feedback-batch-delete-mobile.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }, { width: 390, height: 844 });
  }
  result.status = result.checks.some(check => check.status === 'failed') || result.errors.length || result.blocked.length ? 'failed' : phase === 'before' ? 'reproduced' : 'passed';
} finally { await browser.close(); await save(); }
console.log(JSON.stringify({ status: result.status, checks: result.checks.length, failed: result.checks.filter(check => check.status === 'failed').length, errors: result.errors, blocked: result.blocked }));
if (result.status === 'failed') process.exitCode = 1;
