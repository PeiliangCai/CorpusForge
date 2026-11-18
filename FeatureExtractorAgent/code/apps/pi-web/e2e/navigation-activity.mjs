/** Isolated browser APIs only. Runtime services, user tasks and providers never receive writes. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = process.env.T1_ACTIVITY_ORIGIN ?? 'http://127.0.0.1:30158', phase = process.env.T1_ACTIVITY_PHASE ?? 'after';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14/item5/navigation-activity');
const dist = process.env.T1_ACTIVITY_DIST, BUILD_ID = dist ? (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim() : 'isolated-dev';
const result = { status: 'running', phase, origin, BUILD_ID, dist, checks: [], errors: [], blocked: [], mock_mutations: [], production_business_writes: 0, paid_calls: 0, production_exports: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href), browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const batchId = '11111111-1111-4111-8111-111111111111';
const scope = { catalog_version: 'navigation-fixture', matching_policy_version: 'fixture', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
const profile = { profile_id: 'chosen-profile', provider: 'fixture', model_id: 'fixture-model', api: 'openai-responses', reasoning_effort: 'medium', context_window: 32768, max_output_tokens: 4096, configuration_source: 'server' };
const catalog = { catalog_version: scope.catalog_version, cancers: [{ id: 'lung', name: '肺癌' }], image_types: [{ id: 'ct', name: 'CT', cancer_ids: ['lung'] }], features: [], bindings: [], default_scope: scope, restricted_available: true, development_only: false };
const pdf = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf')), sha = createHash('sha256').update(pdf).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b3sAAAAASUVORK5CYII=', 'base64');
const fragment = (text, run, page = 1) => ({ block_id: run + '-block', text_version: run + '-text', start: 0, end: text.length, exact_quote: text, occurrence: 1, physical_page: page, bbox: [0, 0, 10, 10], location_precision: 'block' });
function seed() {
  const run = (id, paper, title) => ({ run_id: id, document_id: paper, state: 'completed', fixture: true, candidate_count: 1, created_at: '2026-11-15T00:00:00Z', model_id: profile.model_id, model_profile: profile, scope, task_title: title, original_filename: paper + '.pdf', submission: { kind: 'single' }, result_ready: true, task_processing_complete: true });
  const runs = [run('single-a', 'paper-a', '单篇任务A'), run('single-b', 'paper-a', '同论文任务B'), { ...run('member-a', 'paper-a', '批量任务C'), submission: { kind: 'batch', batch_id: batchId } }, { ...run('member-b', 'paper-b', '批量任务C'), submission: { kind: 'batch', batch_id: batchId } }];
  const papers = ['orphan', 'paper-a', 'paper-b'].map(id => ({ id, title: id === 'orphan' ? '例子2.pdf' : id + '来源名称', filename: id + '.pdf', sha256: sha, language: 'en', pages: 12, note: '', uploaded: true, output_ids: runs.filter(run => run.document_id === id).map(run => run.run_id) }));
  return { runs, papers, requests: [], writes: [], missing: '', hold: '', gate: null };
}
async function scenario(name, work, viewport = { width: 1440, height: 1000 }) {
  if (process.env.T1_ACTIVITY_CASES && !process.env.T1_ACTIVITY_CASES.split(',').includes(name)) return;
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' }), state = seed();
  await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); localStorage.setItem('t1:extraction-model-profile', 'chosen-profile'); } }, origin);
  await context.addInitScript(() => {
    const nativeNow = Date.now.bind(Date), nativeFetch = window.fetch.bind(window);
    const control = { offset: 0, disconnected: false, streams: new Set() }; window.__t1ActivityTest = control;
    Date.now = () => nativeNow() + control.offset;
    window.fetch = (input, init) => {
      const value = input instanceof Request ? input.url : String(input), url = new URL(value, location.origin);
      if (!url.pathname.endsWith('/events')) return nativeFetch(input, init);
      if (control.disconnected) return Promise.reject(new TypeError('fixture_stream_disconnected'));
      let saved;
      const stream = new ReadableStream({ start(controller) { saved = controller; control.streams.add(controller); controller.enqueue(new TextEncoder().encode(': isolated connected stream\n\n')); }, cancel() { control.streams.delete(saved); } });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };
  });
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const detail = run => ({ run, paper: state.papers.find(paper => paper.id === run.document_id), output: { id: run.run_id, strategy: 'B0', origin: 'controlled_fixture', state: run.state, scope, records: run.candidate_count ? [{ id: 'same-id', run_id: run.run_id, version: 1, fragments: [fragment('ONLY ' + run.run_id + ' original text', run.run_id)], context: [], association: 'paired', figure_ids: ['same-figure'], proposed_figure_ids: [], reasons: [], review_status: 'pending', text_fingerprint: run.run_id, evidence_role: 'primary_candidate', retention: { status: 'kept', revision: 0, origin: 'default', record_version: 1 } }] : [], coverage: { task_processing_complete: run.task_processing_complete } }, source_units: [], figures: [{ id: 'same-figure', number: '1', verification: 'needs_review', caption: [fragment('ONLY ' + run.run_id + ' caption', run.run_id)], assets: [{ id: 'same-asset', url: '/api/t1/workbench/runs/' + run.run_id + '/figures/same-asset', sha256: run.run_id, page: 1, width: 100, height: 100 }] }], source_issues: state.missing === run.run_id ? ['pdf_source_file_missing'] : [], source_status: state.missing === run.run_id ? 'missing' : 'valid', text_version: run.run_id + '-text', pdf_url: '/api/t1/workbench/papers/' + run.document_id + '/pdf' });
  const remove = ids => { state.runs = state.runs.filter(run => !ids.includes(run.run_id)); state.papers = state.papers.map(paper => ({ ...paper, output_ids: paper.output_ids.filter(id => !ids.includes(id)) })); };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(), base = '/api/t1/workbench';
    if (url.origin !== origin) { result.blocked.push({ name, method, path }); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    state.requests.push({ method, path });
    if (method === 'GET' && path === base + '/capabilities') return json(route, { schema_version: 't1-workbench-capabilities-1', read_only: false, paper_upload: true, extraction_start: true, persisted_review: true, persisted_retention: true, retained_export: true, model_selection: true, backend_pi_sdk: '1.4.0', max_concurrent_runs: 2 });
    if (method === 'GET' && path === base + '/catalog') return json(route, catalog);
    if (method === 'GET' && path === base + '/models') return json(route, { provider: 'fixture', default_profile_id: profile.profile_id, profiles: [profile] });
    if (method === 'GET' && path === base + '/papers') return json(route, { papers: state.papers });
    if (method === 'GET' && path === base + '/runs') return state.failRuns ? json(route, { error: 'fixture_lists_unavailable' }, 503) : json(route, { runs: state.runs });
    if (method === 'GET' && path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': isolated fixture\n\n' });
    if (method === 'GET' && path.endsWith('/pdf')) return route.fulfill({ contentType: 'application/pdf', body: pdf });
    if (method === 'GET' && path.endsWith('/figures/same-asset')) return route.fulfill({ contentType: 'image/png', body: png });
    const runId = path.match(/^\/api\/t1\/workbench\/runs\/([^/]+)$/)?.[1], paperId = path.match(/^\/api\/t1\/workbench\/papers\/([^/]+)$/)?.[1];
    if (method === 'GET' && runId) {
      if (state.hold === runId) await state.gate;
      const run = state.runs.find(run => run.run_id === runId); return run && state.notFound !== runId ? json(route, detail(run)) : json(route, { error: 'workbench_run_not_found' }, 404);
    }
    if (method === 'GET' && paperId) return json(route, { paper: state.papers.find(paper => paper.id === paperId), outputs: state.runs.filter(run => run.document_id === paperId).map(run => detail(run).output), source_units: [], figures: [], source_status: 'not_parsed' });
    if (method === 'DELETE' && (runId || path === base + '/batches/' + batchId)) { state.writes.push({ method, path }); remove(runId ? [runId] : state.runs.filter(run => run.submission.kind === 'batch').map(run => run.run_id)); return json(route, { deleted: true }); }
    if (method === 'POST' && path === base + '/papers') { state.writes.push({ method, path }); return json(route, { paper: { ...state.papers[0], id: 'draft-paper', title: 'draft.pdf', filename: 'draft.pdf' } }, 201); }
    result.blocked.push({ name, method, path }); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => result.errors.push({ name, error: String(error) }));
  const go = async (params = '') => { await page.goto(origin + '/?' + params); await page.locator('.t1-status[role="status"]').waitFor({ state: 'hidden' }); await page.getByRole('tab').first().waitFor(); };
  const choose = async id => { if (!await page.locator('.t1-sidebar').isVisible()) await page.locator('.t1-nav-toggle').click(); await page.locator('[data-submission-list="sidebar"] [data-run-id="' + id + '"]').click(); await page.waitForFunction(id => document.querySelector('.t1-evidence-card')?.getAttribute('data-source-run-id') === id, id); };
  const deleteTask = async id => { if (!await page.locator('.t1-sidebar').isVisible()) await page.locator('.t1-nav-toggle').click(); await page.locator('[data-submission-list="sidebar"] [data-run-menu-id="' + id + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '删除任务', exact: true }); await dialog.waitFor(); await dialog.getByRole('button', { name: '确认删除任务', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
  const globalPage = async view => { if (view === 'newTask') { if (!await page.locator('.t1-sidebar').isVisible()) await page.locator('.t1-nav-toggle').click(); await page.locator('.t1-new-task').click(); } else { if (!await page.locator('.t1-sidebar').isVisible()) await page.locator('.t1-nav-toggle').click(); await page.locator('.t1-sidebar-bottom > button').click(); } await page.waitForFunction(view => new URL(location.href).searchParams.get('view') === view && !new URL(location.href).searchParams.has('paper') && !new URL(location.href).searchParams.has('run'), view); };
  try { await work({ page, state, go, choose, deleteTask, remove, globalPage }); result.checks.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { result.checks.push({ name, status: 'failed', error: String(error) }); console.log('FAIL ' + name + ' ' + error); await page.screenshot({ path: join(evidence, phase + '-failed-' + name + '.png') }); }
  finally { result.mock_mutations.push(...state.writes); await context.close(); }
}
async function assertGlobal(page, label) { assert.equal(await page.locator('.t1-workspace-bar > span').innerText(), label); assert.equal(await page.locator('.t1-source-toggle,.t1-mobile-source,.t1-source').count(), 0); assert.equal(await page.locator('.t1-evidence-card').count(), 0); }
const waiting = state => {
  const started = new Date(Date.now() - 5000).toISOString();
  Object.assign(state.runs[0], { state: 'extracting', result_ready: false, task_processing_complete: undefined,
    progress: { schema_version: 't1-workbench-progress-1', stage: 'extracting', telemetry: 'events', unit: 'content_units', completed: 0, total: 547, candidate_records: 1,
      completed_batches: 1, total_batches: 24, failed_batches: 1, current_batch_index: 3, current_batch_id: 'batch-0003', updated_at: started,
      operation: { kind: 'model_request', state: 'waiting_response', started_at: started, elapsed_ms: 5000, attempt: 1, max_retries: 2 } } });
};
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const refresh = async page => { await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[aria-label="正在刷新工作台…"]')); };
const activity = page => page.locator('.t1-progress-activity');
try {
  if (dist) assert.equal((await fetch(origin + '/_next/static/' + BUILD_ID + '/_buildManifest.js')).status, 200);
  await scenario('desktop_sidebar_and_fixed_rail_keyboard_focus_resize', async ({ page, go }) => {
    await go(); await page.locator('.t1-task-title-field input').fill('导航切换保留草稿');
    assert.equal(await page.locator('.t1-topbar .t1-nav-toggle').count(), 0);
    let close = page.getByRole('button', { name: '收起任务导航', exact: true }); assert.equal(await close.locator('..').locator('strong').innerText(), '抽取任务');
    await close.focus(); await page.keyboard.press('Enter'); let open = page.getByRole('button', { name: '展开任务导航', exact: true }); await open.waitFor(); assert.equal(await open.evaluate(element => element === document.activeElement), true);
    assert.equal(Math.round((await page.locator('.t1-navigation').boundingBox()).width), 44); const rail = await page.locator('.t1-nav-rail').boundingBox(), main = await page.locator('.t1-main').boundingBox(); assert.ok(main.x >= rail.x + rail.width - 1); assert.equal(await page.locator('.t1-nav-toggle').count(), 1);
    await page.screenshot({ path: join(evidence, phase + '-rail-desktop.png') });
    await page.keyboard.press('Enter'); await close.waitFor(); assert.equal(await close.evaluate(element => element === document.activeElement), true);
    const separator = page.locator('.t1-resize[role="separator"]').first(), before = await page.locator('.t1-navigation').boundingBox(); await separator.focus(); await page.keyboard.press('ArrowRight'); const after = await page.locator('.t1-navigation').boundingBox(); assert.ok(after.width > before.width);
    await close.click(); await open.waitFor(); await open.click(); await close.waitFor(); assert.ok(Math.abs((await page.locator('.t1-navigation').boundingBox()).width - after.width) <= 1); assert.equal(await page.locator('.t1-task-title-field input').inputValue(), '导航切换保留草稿'); await page.screenshot({ path: join(evidence, phase + '-sidebar-desktop.png') });
  });
  await scenario('mobile_drawer_keeps_main_geometry_and_edge_focus', async ({ page, go, choose, globalPage }) => {
    await go(); const open = page.getByRole('button', { name: '展开任务导航', exact: true }); await open.waitFor(); const before = await page.locator('.t1-main').boundingBox(); assert.equal(Math.round((await page.locator('.t1-navigation').boundingBox()).width), 36);
    await open.focus(); await page.keyboard.press('Enter'); const close = page.getByRole('button', { name: '收起任务导航', exact: true }); await close.waitFor(); assert.deepEqual(await page.locator('.t1-main').boundingBox(), before); assert.equal(await close.evaluate(element => element === document.activeElement), true); await page.screenshot({ path: join(evidence, phase + '-drawer-mobile.png') });
    await page.keyboard.press('Escape'); await open.waitFor(); assert.equal(await open.evaluate(element => element === document.activeElement), true); assert.deepEqual(await page.locator('.t1-main').boundingBox(), before);
    await choose('single-a'); assert.equal(await page.locator('.t1-results-actions .t1-mobile-source').isVisible(), true); const source = await page.locator('.t1-results-actions .t1-mobile-source').boundingBox(), rail = await page.locator('.t1-nav-rail').boundingBox(); assert.ok(source.x >= rail.x + rail.width); assert.equal(await page.locator('.t1-topbar .t1-nav-toggle').count(), 0); await page.screenshot({ path: join(evidence, phase + '-results-mobile.png') });
    await globalPage('newTask'); await assertGlobal(page, '创建任务'); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }, { width: 390, height: 844 });
  await scenario('live_request_tool_retry_and_actual_batch_numbers', async ({ page, state, go }) => {
    waiting(state); await go('run=single-a&view=records'); await page.locator('.t1-evidence-card').waitFor(); await page.locator('[data-activity-status="waiting"]').waitFor(); assert.match(await activity(page).innerText(), /等待模型响应/); const bar = page.getByRole('progressbar'); assert.equal(await bar.getAttribute('aria-valuenow'), '0');
    assert.match(await page.locator('.t1-progress-detail').innerText(), /当前第 3 批/); assert.match(await page.locator('.t1-progress-detail').innerText(), /已完成 1 \/ 24 批/); assert.match(await page.locator('.t1-progress-detail').innerText(), /已失败 1 批/);
    const old = await activity(page).innerText(); await page.waitForFunction(previous => document.querySelector('.t1-progress-activity')?.textContent !== previous, old, { timeout: 4000 }); assert.equal(await bar.getAttribute('aria-valuenow'), '0'); await page.screenshot({ path: join(evidence, phase + '-waiting-desktop.png') });
    state.runs[0].progress.operation.state = 'receiving_response'; await refresh(page); await page.locator('[data-activity-status="receiving"]').waitFor(); assert.equal(await bar.getAttribute('aria-valuenow'), '0');
    Object.assign(state.runs[0].progress.operation, { kind: 'tool', state: 'executing', tool_name: 'read_document_blocks' }); await refresh(page); await page.locator('[data-activity-status="tool"]').waitFor(); assert.doesNotMatch(await activity(page).innerText(), /read_document_blocks/);
    await page.locator('.t1-notes-toggle').click(); const notes = page.getByRole('dialog', { name: '说明', exact: true }); await notes.waitFor(); await notes.locator('.t1-operation-details > summary').click(); assert.match(await notes.locator('.t1-operation-details').innerText(), /本次请求尝试 2 \/ 3/); assert.match(await notes.locator('.t1-operation-details').innerText(), /read_document_blocks/); await page.keyboard.press('Escape'); await notes.waitFor({ state: 'hidden' });
    Object.assign(state.runs[0].progress.operation, { kind: 'retry', state: 'scheduled' }); state.runs[0].progress.last_request = { outcome: 'failed', finished_at: new Date().toISOString(), error_code: 'provider_timeout' }; await refresh(page); await page.locator('[data-activity-status="retry"]').waitFor(); assert.equal(await bar.getAttribute('aria-valuenow'), '0');
    state.runs[0].state = 'reconciling'; state.runs[0].progress.stage = 'reconciling'; await refresh(page); assert.doesNotMatch(await page.locator('.t1-progress-detail').innerText(), /当前第/); assert.match(await page.locator('.t1-progress-detail').innerText(), /已完成 1 \/ 24 批/);
  });
  await scenario('stopped_states_outrank_leftover_operations_and_finalization', async ({ page, state, go }) => {
    for (const terminal of ['cancelled', 'failed', 'interrupted', 'partial']) {
      waiting(state); state.runs[0].state = terminal; state.runs[0].result_ready = terminal !== 'cancelled'; state.runs[0].task_processing_complete = false;
      await go('run=single-a&view=records'); await page.locator('.t1-evidence-card').waitFor(); await page.locator('[data-activity-status="' + (terminal === 'partial' ? 'ended' : 'stopped') + '"]').waitFor(); assert.match(await activity(page).innerText(), terminal === 'partial' ? /运行已结束/ : /任务已停止/);
      assert.equal(await page.locator('.t1-progress-track.is-indeterminate').count(), 0); assert.equal(await page.locator('.t1-progress-stages [aria-current="step"]').count(), 0); assert.doesNotMatch(await activity(page).innerText(), /等待模型|接收模型|已用时/); assert.doesNotMatch(await page.locator('.t1-progress-detail').innerText(), /当前第/);
      const before = await activity(page).innerText(); await pause(1100); assert.equal(await activity(page).innerText(), before); if (terminal === 'cancelled') await page.screenshot({ path: join(evidence, phase + '-cancelled.png') });
    }
  });
  await scenario('connection_loss_and_stale_reads_freeze_only_recorded_wait', async ({ page, state, go }) => {
    waiting(state); await go('run=single-a&view=records'); await page.locator('[data-activity-status="waiting"]').waitFor();
    await page.evaluate(() => { const control = window.__t1ActivityTest; control.disconnected = true; for (const stream of control.streams) stream.error(new Error('fixture_disconnect')); control.streams.clear(); });
    await page.locator('[data-activity-status="disconnected"]').waitFor(); assert.match(await activity(page).innerText(), /最近：等待模型响应/); assert.match(await activity(page).innerText(), /记录耗时/); let before = await activity(page).innerText(); await pause(1100); assert.equal(await activity(page).innerText(), before);
    await page.reload(); await page.locator('[data-activity-status="waiting"]').waitFor(); await page.evaluate(() => { window.__t1ActivityTest.offset = 35000; }); await page.locator('[data-activity-status="stale"]').waitFor(); before = await activity(page).innerText();
    await page.evaluate(() => { for (const stream of window.__t1ActivityTest.streams) stream.enqueue(new TextEncoder().encode(': keepalive\n\n')); }); await pause(1100); assert.equal(await activity(page).innerText(), before); assert.match(before, /状态待更新/); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '0'); await page.screenshot({ path: join(evidence, phase + '-stale.png') });
  });
  await scenario('legacy_unknown_activity_and_global_context_remain_honest', async ({ page, state, go, globalPage }) => {
    waiting(state); delete state.runs[0].progress.operation; delete state.runs[0].progress.current_batch_index; await go('run=single-a&view=records'); await page.locator('[data-activity-status="processing"]').waitFor(); assert.match(await activity(page).innerText(), /当前活动未记录/); assert.doesNotMatch(await activity(page).innerText(), /等待模型|已用时/); assert.match(await page.locator('.t1-progress-updated').innerText(), /最近事件/);
    await globalPage('tasks'); await assertGlobal(page, '任务与历史'); assert.equal(await page.locator('.t1-progress-activity').count(), 0); await globalPage('newTask'); await assertGlobal(page, '创建任务');
  });
  await scenario('verified_quota_stop_is_visible_and_unknown_partial_is_not_guessed', async ({ page, state, go }) => {
    waiting(state); Object.assign(state.runs[0], { state: 'partial', result_ready: true, task_processing_complete: false }); state.runs[0].progress.termination_reason = 'experiment_input_token_limit'; state.runs[0].progress.completed = 304; state.runs[0].progress.completed_batches = 19;
    await go('run=single-a&view=records'); await page.locator('[data-activity-status="stopped"]').waitFor(); assert.match(await activity(page).innerText(), /已停止：调用额度不足，已保留结果/); assert.match(await page.locator('.t1-progress-detail').innerText(), /304 \/ 547/); assert.match(await page.locator('.t1-progress-detail').innerText(), /已完成 19 \/ 24 批/); assert.doesNotMatch(await activity(page).innerText(), /等待模型|已用时/); assert.equal(await page.locator('.t1-progress-track.is-indeterminate').count(), 0); await page.screenshot({ path: join(evidence, phase + '-quota-stopped.png') });
    delete state.runs[0].progress.termination_reason; state.runs[0].progress.last_request = { outcome: 'failed', finished_at: new Date().toISOString(), error_code: 'provider_timeout' }; await go('run=single-a&view=records'); await page.locator('[data-activity-status="ended"]').waitFor(); assert.doesNotMatch(await activity(page).innerText(), /额度|供应商|超时/);
  });
  result.status = result.checks.every(check => check.status === 'passed') && !result.errors.length && !result.blocked.length ? 'passed' : 'failed';
} finally { await browser.close(); await writeFile(join(evidence, 'browser-' + phase + '.json'), JSON.stringify({ ...result, completed_at_utc: new Date().toISOString() }, null, 2) + '\n'); console.log(JSON.stringify(result)); }
if (result.status !== 'passed') process.exitCode = 1;
