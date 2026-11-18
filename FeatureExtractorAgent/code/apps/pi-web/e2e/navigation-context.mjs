/** Isolated browser APIs only. Runtime services, user tasks and providers never receive writes. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = process.env.T1_NAV_ORIGIN ?? 'http://127.0.0.1:30158', phase = process.env.T1_NAV_PHASE ?? 'dev';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14/item5/navigation-context');
const dist = process.env.T1_NAV_DIST, BUILD_ID = dist ? (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim() : 'isolated-dev';
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
  if (process.env.T1_NAV_CASES && !process.env.T1_NAV_CASES.split(',').includes(name)) return;
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' }), state = seed();
  await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); localStorage.setItem('t1:extraction-model-profile', 'chosen-profile'); } }, origin);
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
try {
  if (dist) assert.equal((await fetch(origin + '/_next/static/' + BUILD_ID + '/_buildManifest.js')).status, 200);
  await scenario('fresh_and_stale_global_urls', async ({ page, state, go }) => {
    for (const query of ['', 'paper=orphan&view=newTask', 'paper=orphan&view=records', 'paper=orphan&view=figures', 'paper=paper-a&run=deleted&record=stale&view=records', 'paper=paper-a&run=single-a&view=newTask', 'paper=paper-a&run=single-a&view=tasks']) {
      await go(query); const expected = query.endsWith('view=tasks') ? '任务与历史' : '创建任务'; await assertGlobal(page, expected); assert.equal(await page.getByRole('tab').count(), 1); assert.ok(!new URL(page.url()).searchParams.has('paper')); assert.ok(!new URL(page.url()).searchParams.has('run')); assert.ok(!new URL(page.url()).searchParams.has('record'));
    }
    assert.equal(state.requests.filter(request => /\/papers\/[^/]+$/.test(request.path)).length, 0); await page.screenshot({ path: join(evidence, phase + '-global-history.png') });
    state.failRuns = true; await go('paper=paper-a&run=single-a&record=saved&view=records'); assert.equal(new URL(page.url()).searchParams.get('run'), 'single-a'); assert.ok(await page.locator('.t1-alert').count());
    state.failRuns = false; await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.t1-evidence-card')?.getAttribute('data-source-run-id') === 'single-a'); assert.equal(new URL(page.url()).searchParams.get('run'), 'single-a');
  });
  await scenario('exact_single_context_global_hierarchy_and_draft', async ({ page, go, choose, globalPage }) => {
    await go(); await page.locator('.t1-task-title-field input').fill('未提交草稿'); await page.locator('input[type="file"][multiple]').first().setInputFiles({ name: 'draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% draft fixture\n%%EOF\n') }); await page.locator('.t1-file-list [data-upload-state="uploaded"]').waitFor();
    await choose('single-a'); assert.equal(await page.locator('.t1-workspace-bar > span').innerText(), '单篇任务A'); assert.equal(await page.locator('.t1-source-toggle').count(), 1); assert.equal(await page.locator('.t1-workspace-bar button').count(), 0); assert.equal(await page.locator('.t1-sidebar-heading .t1-nav-toggle').count(), 1); assert.equal(await page.locator('.t1-topbar .t1-nav-toggle').count(), 0);
    await page.locator('.t1-source-toggle').click(); await page.locator('.t1-source').waitFor(); await globalPage('tasks'); await assertGlobal(page, '任务与历史');
    await globalPage('newTask'); await assertGlobal(page, '创建任务'); assert.equal(await page.locator('.t1-task-title-field input').inputValue(), '未提交草稿'); assert.equal(await page.locator('.t1-file-list [data-upload-state="uploaded"]').count(), 1); await page.screenshot({ path: join(evidence, phase + '-creation-desktop.png') });
    await page.reload(); await page.locator('.t1-new-task-panel:not([hidden])').waitFor(); assert.equal(await page.getByRole('tab').count(), 1); await assertGlobal(page, '创建任务');
  });
  await scenario('single_batch_figures_and_original_follow_exact_child', async ({ page, go, choose, globalPage }) => {
    await go('paper=orphan&run=single-a&view=records'); await page.locator('.t1-evidence-card').waitFor(); assert.equal(await page.getByRole('tab').count(), 1); assert.equal(new URL(page.url()).searchParams.get('paper'), 'paper-a');
    await choose('member-a'); await page.waitForFunction(() => document.querySelectorAll('.t1-index-list button').length === 2); await page.locator('[data-index-run-id="member-b"]').click(); await page.waitForFunction(() => document.querySelector('.t1-evidence-card')?.getAttribute('data-source-run-id') === 'member-b'); assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-source-paper-id'), 'paper-b');
    await page.locator('.t1-results-actions').getByRole('button', { name: '原 Figure 目录', exact: true }).click(); await page.locator('.t1-content[data-view="figures"]').waitFor(); assert.equal(await page.locator('.t1-workspace-bar > span').innerText(), '批量任务C'); assert.ok((await page.locator('.t1-figure img').getAttribute('src')).includes('/runs/member-b/figures/'));
    await page.locator('.t1-source-toggle').click(); await page.locator('.t1-source').waitFor(); assert.ok((await page.locator('.t1-source-heading a').getAttribute('href')).includes('/papers/paper-b/pdf')); await page.screenshot({ path: join(evidence, phase + '-batch-figures-desktop.png') });
    await globalPage('newTask'); await assertGlobal(page, '创建任务'); await choose('single-b'); assert.equal(await page.locator('[data-batch-results]').count(), 0); assert.equal(await page.locator('.t1-workspace-bar > span').innerText(), '同论文任务B');
  });
  await scenario('deleting_current_never_selects_same_paper_sibling_and_all_tasks_leave_no_orphan_context', async ({ page, state, go, choose, deleteTask }) => {
    await go(); await choose('single-a'); await deleteTask('single-a'); await page.locator('.t1-new-task-panel:not([hidden])').waitFor(); await assertGlobal(page, '创建任务'); assert.equal(await page.getByRole('tab', { name: '抽取结果', exact: true }).count(), 0); assert.equal(state.runs.length, 3); assert.ok(!new URL(page.url()).searchParams.has('paper'));
    await choose('single-b'); await deleteTask('member-a'); assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-source-run-id'), 'single-b'); assert.equal(state.runs.length, 1);
    await deleteTask('single-b'); await page.locator('.t1-new-task-panel:not([hidden])').waitFor(); await assertGlobal(page, '创建任务'); assert.equal(state.runs.length, 0); assert.equal(state.papers.length, 3); await page.reload(); await page.locator('.t1-new-task-panel:not([hidden])').waitFor(); await assertGlobal(page, '创建任务'); assert.equal(await page.getByRole('tab').count(), 1); await page.screenshot({ path: join(evidence, phase + '-no-tasks.png') });
  });
  await scenario('external_delete_refresh_clears_context_without_touching_draft', async ({ page, go, choose, remove, globalPage }) => {
    await go(); await page.locator('.t1-task-title-field input').fill('刷新保留草稿'); await choose('single-a'); remove(['single-a']); await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-new-task-panel:not([hidden])').waitFor(); await assertGlobal(page, '创建任务'); assert.equal(await page.locator('.t1-task-title-field input').inputValue(), '刷新保留草稿'); assert.ok(!new URL(page.url()).searchParams.has('run'));
    await choose('single-b'); await globalPage('tasks'); remove(['single-b', 'member-a', 'member-b']); await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[data-submission-list="history"] [data-submission-group]') === null); await assertGlobal(page, '任务与历史'); assert.equal(await page.getByRole('tab', { name: '抽取结果', exact: true }).count(), 0);
  });
  await scenario('missing_source_and_not_found_do_not_expose_another_original', async ({ page, state, go, globalPage }) => {
    state.missing = 'single-a'; await go('run=single-a&view=records'); await page.locator('.t1-evidence-card').waitFor(); assert.equal(await page.locator('.t1-source-toggle,.t1-mobile-source').count(), 0); assert.ok((await page.locator('.t1-alert').allTextContents()).some(text => /来源|原文/.test(text)));
    await globalPage('tasks'); await assertGlobal(page, '任务与历史'); assert.equal(await page.locator('.t1-source-recovery,.t1-alert').count(), 0);
    await globalPage('newTask'); await assertGlobal(page, '创建任务'); assert.equal(await page.locator('.t1-source-recovery,.t1-alert').count(), 0);
    state.notFound = 'single-b'; await go('run=single-b&view=records'); await page.locator('.t1-new-task-panel:not([hidden])').waitFor(); await assertGlobal(page, '创建任务'); assert.ok(!new URL(page.url()).searchParams.has('run'));
  });
  await scenario('mobile_navigation_is_global_and_source_action_stays_with_results', async ({ page, go, choose, globalPage }) => {
    await go(); await assertGlobal(page, '创建任务'); assert.equal(await page.locator('.t1-nav-toggle').isVisible(), true); await choose('member-a'); assert.equal(await page.locator('.t1-results-actions .t1-mobile-source').isVisible(), true); assert.equal(await page.locator('.t1-brand .t1-mobile-source').count(), 0); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(evidence, phase + '-results-mobile.png') });
    await globalPage('newTask'); await assertGlobal(page, '创建任务'); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(evidence, phase + '-creation-mobile.png') });
  }, { width: 390, height: 844 });
  await scenario('content_composition_and_processing_batches_remain_truthful_for_new_and_legacy_runs', async ({ page, state, go }) => {
    for (const unit of ['content_units', 'paragraphs']) {
      Object.assign(state.runs[0], { state: 'extracting', task_processing_complete: undefined, result_ready: false, progress: { schema_version: 't1-workbench-progress-1', stage: 'extracting', unit, completed: unit === 'paragraphs' ? 100 : 28, total: unit === 'paragraphs' ? 2158 : 55, completed_batches: 4, total_batches: 39, candidate_records: 1, telemetry: 'events', ...(unit === 'content_units' ? { unit_counts: { paragraph: 10, figure_text: 40, heading: 2, source_fragment: 3 }, completed_unit_counts: { paragraph: 5, figure_text: 20, heading: 2, source_fragment: 1 } } : {}) } });
      await go('run=single-a&view=records'); await page.locator('.t1-evidence-card').waitFor(); assert.match(await page.locator('.t1-progress-detail').innerText(), /内容单元/); assert.match(await page.locator('.t1-progress-detail').innerText(), /已完成 4 \/ 39 批/); assert.doesNotMatch(await page.locator('.t1-progress-detail').innerText(), /抽取窗口|自然段/);
      await page.locator('.t1-notes-toggle').click(); const dialog = page.getByRole('dialog', { name: '说明', exact: true }); await dialog.waitFor(); assert.match(await dialog.innerText(), /批次数不等于模型请求次数/);
      if (unit === 'content_units') { assert.equal(await dialog.locator('.t1-unit-composition > div').count(), 4); assert.match(await dialog.locator('.t1-unit-composition').innerText(), /正文句段\s+已处理 5 \/ 10/); assert.match(await dialog.locator('.t1-unit-composition').innerText(), /图内文字组\s+已处理 20 \/ 40/); }
      else { assert.equal(await dialog.locator('.t1-unit-composition').count(), 0); assert.match(await dialog.innerText(), /未记录内容组成，不能从总内容数推算正文段落数/); }
      await page.screenshot({ path: join(evidence, phase + '-composition-' + unit + '.png') }); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    }
  });
  result.status = result.checks.every(check => check.status === 'passed') && !result.errors.length && !result.blocked.length ? 'passed' : 'failed';
} finally { await browser.close(); await writeFile(join(evidence, 'browser-' + phase + '.json'), JSON.stringify({ ...result, completed_at_utc: new Date().toISOString() }, null, 2) + '\n'); console.log(JSON.stringify(result)); }
if (result.status !== 'passed') process.exitCode = 1;
