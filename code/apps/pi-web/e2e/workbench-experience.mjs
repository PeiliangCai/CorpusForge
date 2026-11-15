/** Same built gateway against the approved isolated workflow only. UI state
 * projections below are engineering cases, never new model/medical results. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30156', evidence = join(code, 'docs/acceptance/workbench-experience-2026-11-14');
const dist = 'apps/pi-web/build/workbench-experience-validated-20261114';
const runtime = JSON.parse(await readFile(join(code, 'runtime-data/two-layer-catalog-fixture-20261114/runtime.json'), 'utf8'));
await mkdir(evidence, { recursive: true });
const result = { schema_version: 't1-workbench-experience-ui-1', status: 'in_progress', origin, isolated_backend: 'http://127.0.0.1:3215', dist,
  BUILD_ID: (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim(), checks: [], errors: [], blocked: [], mutations: [], submissions: [], screenshots: [],
  engineering_ui_state_projection: true, paid_model_calls: 0, production_business_writes: 0, exports_requested: 0, independent_IN_materials_opened: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
let projectedDetail = null, projectedEvents = [], loseNextStart = false;
const deleteAllowlist = new Set();
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (url.origin !== origin || url.pathname.includes('/exports/')) { result.blocked.push({ path: url.pathname, method }); return route.abort('blockedbyclient'); }
  if (url.pathname === '/t1-engineering-missing-image.png') return route.fulfill({ status: 404, body: 'Engineering missing-asset case' });
  if (!url.pathname.startsWith('/api/t1/')) return route.continue();
  if (!['GET', 'HEAD'].includes(method)) {
    const start = method === 'POST' && /\/papers\/[^/]+\/runs$/.test(url.pathname), upload = method === 'POST' && url.pathname.endsWith('/workbench/papers');
    const deletion = method === 'DELETE' && deleteAllowlist.has(url.pathname.split('/').at(-1));
    if (!(start || upload || deletion)) { result.blocked.push({ path: url.pathname, method }); return route.abort('blockedbyclient'); }
    result.mutations.push({ method, path: url.pathname });
    if (start) {
      const headers = await request.allHeaders(), response = await route.fetch(), json = await response.json();
      result.submissions.push({ paper_id: url.pathname.split('/').at(-2), request_id: headers['x-t1-request-id'], ...request.postDataJSON(), response_status: response.status(), run_id: json.run?.run_id });
      if (loseNextStart && response.ok()) { loseNextStart = false; return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"engineering_response_lost_after_admission"}' }); }
      return route.fulfill({ response });
    }
  }
  if (method === 'GET' && projectedDetail && url.pathname.endsWith('/runs/' + runtime.run)) return route.fulfill({ json: projectedDetail });
  if (method === 'GET' && projectedDetail && url.pathname.endsWith('/runs/' + runtime.run + '/events')) return route.fulfill({ contentType: 'text/event-stream', body: projectedEvents.map((event, index) => `data: ${JSON.stringify({ run_id: runtime.run, seq: index + 1, timestamp: new Date().toISOString(), ...event })}\n\n`).join('') });
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => result.errors.push(String(error)));
const json = async path => { const response = await context.request.get(origin + '/api/t1/workbench/' + path); assert.equal(response.status(), 200, path); return response.json(); };
const check = async (name, action) => { await action(); result.checks.push(name); console.log('PASS ' + name); };
const persist = () => writeFile(join(evidence, 'ui.json'), JSON.stringify(result, null, 2) + '\n');
const batch = () => page.locator('.t1-batch'), idle = () => page.locator('.t1-batch[aria-busy="false"]').waitFor();
const scope = () => page.locator('.t1-scope-editor');
const sidebarRow = id => page.locator(`[data-submission-list="sidebar"] [data-run-id="${id}"]`);
const newTask = async () => { await page.goto(origin + '/?view=newTask'); await scope().waitFor(); };
const openRun = async id => { await page.goto(origin + '/?' + new URLSearchParams({ run: id, view: 'records' })); await page.locator('.t1-evidence-card').waitFor(); };
async function shot(name) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(evidence, name) }); result.screenshots.push(name); }
async function uploadFiles(names) { const buffer = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf')); await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(names.map(name => ({ name, mimeType: 'application/pdf', buffer }))); await batch().getByRole('button', { name: `上传待处理 PDF（${names.length} 篇）`, exact: true }).click(); await idle(); }
async function menu(id, label) { await page.locator(`[data-submission-list="sidebar"] [data-run-menu-id="${id}"]`).click(); await page.getByRole('menuitem', { name: label, exact: true }).click(); }
const baseline = await json('runs/' + runtime.run);
assert.equal((await json('capabilities')).controlled_fixture, true);
assert.equal(baseline.run.fixture, true, 'Gateway must reach the isolated workflow before any write');
const sourceQuotes = baseline.output.records[0].fragments.map(fragment => fragment.exact_quote);
function project(state, options = {}) {
  projectedDetail = structuredClone(baseline); projectedDetail.run.state = state; projectedDetail.output.state = state;
  projectedDetail.output.coverage = options.coverage;
  if (options.legacy) { delete projectedDetail.run.progress; delete projectedDetail.run.execution_started_at; delete projectedDetail.run.finished_at; delete projectedDetail.run.queue_wait_ms; projectedDetail.run.created_at = '2020-01-01T00:00:00Z'; }
  else {
    projectedDetail.run.created_at = new Date(Date.now() - 32000).toISOString();
    projectedDetail.run.execution_started_at = state === 'queued' ? undefined : new Date(Date.now() - 30000).toISOString();
    projectedDetail.run.finished_at = ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(state) ? new Date().toISOString() : undefined;
    projectedDetail.run.progress = { schema_version: 't1-workbench-progress-1', stage: state, candidate_records: baseline.output.records.length, telemetry: 'events', execution_elapsed_ms: state === 'queued' ? undefined : 30000, ...options.progress };
  }
  projectedEvents = options.events ?? [{ type: 'state', detail: { state: state === 'partial' ? 'reconciling' : state } }];
  if (options.oldEvents) delete projectedDetail.run.progress;
}
async function showProjection(state, options) { project(state, options); await openRun(runtime.run); await page.locator('.t1-run-progress').waitFor(); }
try {
  await check('new_task_has_one_local_upload_flow_two_scope_layers_and_no_explicit_reuse', async () => {
    await newTask(); assert.equal(await scope().locator('fieldset').count(), 2); assert.equal(await page.locator('.t1-reuse-paper').count(), 0);
    assert.equal(await page.locator('.t1-batch-actions .t1-primary').isDisabled(), true); assert.equal(await page.getByText('按上方范围为单篇另开任务', { exact: true }).count(), 0);
    assert.equal(await page.getByText('本次任务论文', { exact: true }).count(), 0); assert.equal(await batch().getByRole('button', { name: '选择文件', exact: true }).count(), 1); assert.equal(await batch().getByRole('button', { name: '选择文件夹', exact: true }).count(), 1);
    await shot('new-task-desktop.png');
  });
  await check('single_upload_and_clear_selection_keep_paper_and_tasks_without_creating_a_run', async () => {
    await newTask(); const before = (await json('runs')).runs.length, papersBefore = (await json('papers')).papers.length;
    await uploadFiles(['engineering-single.pdf']); assert.ok((await batch().innerText()).includes('仅清空本次上传选择，保留已上传论文和已提交任务。'));
    await batch().getByRole('button', { name: '清空本次选择', exact: true }).click(); assert.equal(await page.locator('[data-batch-member]').count(), 0);
    assert.equal((await json('runs')).runs.length, before); assert.equal((await json('papers')).papers.length, papersBefore + 1);
  });
  await check('folder_pdfs_share_existing_batch_admission_and_lost_response_retry_keeps_scope_and_request_identity', async () => {
    const directory = join(code, 'runtime-data/workbench-experience-ui-folder'), buffer = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf'));
    await mkdir(join(directory, 'nested'), { recursive: true }); await writeFile(join(directory, 'first.pdf'), buffer); await writeFile(join(directory, 'nested/second.pdf'), buffer); await writeFile(join(directory, 'ignored.txt'), 'Engineering folder-selection fixture.');
    await page.locator('.t1-batch input[webkitdirectory]').setInputFiles(directory); await batch().getByRole('button', { name: '上传待处理 PDF（2 篇）', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-batch-member]').count(), 2); const before = result.submissions.length; loseNextStart = true;
    await batch().getByRole('button', { name: '批量开始抽取（2 篇）', exact: true }).click(); await idle(); assert.equal(await page.locator('[data-upload-state="startFailed"]').count(), 1);
    const first = result.submissions[before]; await page.getByLabel('癌种', { exact: true }).selectOption('selected'); await scope().getByRole('checkbox', { name: '肺癌', exact: true }).check();
    await batch().getByRole('button', { name: '重试提交抽取', exact: true }).click(); await idle(); const replay = result.submissions.at(-1);
    assert.equal(replay.request_id, first.request_id); assert.equal(replay.run_id, first.run_id); assert.deepEqual(replay.scope, first.scope); assert.deepEqual(replay.submission, first.submission);
    assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 2); const tasks = (await json('runs')).runs.filter(run => run.submission?.batch_id === first.submission.batch_id); assert.equal(tasks.length, 2);
    const beforeClear = (await json('runs')).runs.length; await batch().getByRole('button', { name: '清空本次选择', exact: true }).click(); assert.equal((await json('runs')).runs.length, beforeClear);
    result.frozen_batch = { first_request: first.request_id, batch_id: first.submission.batch_id, tasks: tasks.length, scope_frozen: true };
  });
  await check('catalog_save_refresh_repairs_new_draft_and_preserves_admitted_scope_catalog_snapshots', async () => {
    const configPath = join(runtime.directory, 'config/scope-catalog.json'), original = await readFile(configPath, 'utf8'), changed = JSON.parse(original);
    const frozenRun = result.submissions.find(item => item.run_id), before = (await json('runs/' + frozenRun.run_id)).run;
    await uploadFiles(['engineering-catalog-refresh.pdf']); changed.cancers.find(item => item.id === 'CANCER-LUNG').name = '肺癌（工程改名）';
    try {
      await writeFile(configPath, JSON.stringify(changed, null, 2) + '\n'); await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).click(); await idle();
      assert.ok((await batch().innerText()).includes('范围选项已更新，请刷新工作台'));
      await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-refresh-toast').waitFor(); await page.waitForFunction(() => !document.querySelector('.t1-refresh-center'));
      assert.equal(await scope().getByRole('checkbox', { name: '肺癌（工程改名）', exact: true }).isChecked(), true); assert.equal(await scope().locator('fieldset').count(), 2);
      await batch().getByRole('button', { name: '重试提交抽取', exact: true }).click(); await idle(); const admitted = result.submissions.at(-1), saved = (await json('runs/' + admitted.run_id)).run;
      assert.equal(saved.scope_catalog.cancers.find(item => item.id === 'CANCER-LUNG').name, '肺癌（工程改名）');
      await writeFile(configPath, original); await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.t1-refresh-center'));
      assert.ok((await page.locator('.t1-batch-scope').innerText()).includes('肺癌（工程改名）')); assert.equal(await scope().getByRole('checkbox', { name: '肺癌', exact: true }).isChecked(), true);
      assert.deepEqual((await json('runs/' + frozenRun.run_id)).run.scope_catalog, before.scope_catalog); assert.deepEqual((await json('runs/' + admitted.run_id)).run.scope_catalog, saved.scope_catalog);
      await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
    } finally { await writeFile(configPath, original); }
  });
  await check('queued_and_pdf_figure_discovery_show_indeterminate_stages', async () => {
    await showProjection('queued'); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null); await page.getByText(/已排队/).waitFor();
    await showProjection('parsing', { progress: { activity: 'figure_discovery' } }); assert.equal(await page.locator('.t1-run-progress').getAttribute('data-progress-stage'), 'parsing'); assert.equal(await page.getByText('正在提取论文原图。', { exact: true }).count(), 1);
  });
  await check('known_source_work_shows_exact_fraction_and_clock_never_increments_percentage', async () => {
    await showProjection('extracting', { progress: { completed: 25, total: 100, unit: 'source_blocks' } }); await page.getByText('原文抽取阶段 · 25 / 100 块 · 25%', { exact: true }).waitFor();
    const before = await page.getByRole('progressbar').getAttribute('aria-valuenow'); await page.waitForTimeout(2100); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), before); await shot('progress-known-desktop.png');
  });
  await check('summary_remains_indeterminate_after_2929_dispatched_blocks_and_41_source_gaps_are_visible', async () => {
    await showProjection('reconciling', { progress: { completed: 2929, total: 2929, unit: 'source_blocks', source_gap_blocks: 41 }, coverage: { task_processing_complete: false } });
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null); assert.ok((await page.locator('.t1-run-progress').innerText()).includes('41 块原文存在读取缺口')); assert.ok(!(await page.locator('.t1-run-progress').innerText()).includes('100%'));
    assert.equal(await page.locator('.t1-progress-track.is-indeterminate').count(), 1); await shot('progress-summary-desktop.png');
  });
  await check('partial_failed_cancelled_interrupted_do_not_show_success_or_100_percent', async () => {
    for (const state of ['partial', 'failed', 'cancelled', 'interrupted']) {
      await showProjection(state, { progress: { completed: 100, total: 100 }, coverage: { task_processing_complete: false } });
      assert.equal(await page.locator('.t1-run-progress').getAttribute('data-progress-outcome'), 'incomplete'); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null); assert.ok(!(await page.locator('.t1-run-progress').innerText()).includes('100%'));
    }
    await showProjection('partial', { progress: { completed: 2929, total: 2929, source_gap_blocks: 41 }, coverage: { task_processing_complete: false } }); await shot('progress-partial-desktop.png');
  });
  await check('legacy_terminal_missing_times_is_unrecorded_and_only_confirmed_complete_can_fill_success', async () => {
    await showProjection('completed', { legacy: true }); assert.equal(await page.getByText('耗时未记录', { exact: true }).count(), 1); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null);
    await showProjection('completed', { coverage: { task_processing_complete: true }, progress: { completed: 100, total: 100 } }); assert.equal(await page.locator('.t1-run-progress').getAttribute('data-progress-outcome'), 'complete'); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '100');
  });
  await check('current_old_backend_events_derive_real_counts_without_new_contract_or_summary_reread_credit', async () => {
    await showProjection('extracting', { oldEvents: true, events: [{ type: 'state', detail: { state: 'extracting' } }, { type: 'coverage_inventory', detail: { dispatched_blocks: 8 } }, { type: 'batch', detail: { status: 'completed', assigned_block_ids: ['a', 'b'] } }, { type: 'batch', detail: { status: 'completed', assigned_block_ids: ['a', 'b'] } }, { type: 'summary_read', detail: { source_block_ids: ['c', 'd', 'e', 'f', 'g', 'h'] } }, ...Array.from({ length: 510 }, () => ({ type: 'tool', detail: { summary: 'Engineering diagnostic event' } }))] });
    await page.getByText('原文抽取阶段 · 2 / 8 块 · 25%', { exact: true }).waitFor(); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '25');
  });
  await check('explicit_pair_is_visible_with_full_source_figure_original_caption_and_unchanged_text', async () => {
    project('partial', { coverage: { task_processing_complete: false } }); const figure = projectedDetail.figures.find(item => item.assets.length > 0); assert.ok(figure);
    projectedDetail.output.records[0].association = 'paired'; projectedDetail.output.records[0].figure_ids = [figure.id]; await openRun(runtime.run);
    assert.deepEqual(await page.locator('.t1-quote-frame .t1-source-fragment').allTextContents(), sourceQuotes); await page.getByRole('button', { name: /查看对应配图/ }).click();
    const image = page.locator('.t1-association img'); await image.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.t1-association img')].every(img => img.complete && img.naturalWidth > 0));
    assert.equal(await image.first().getAttribute('src'), figure.assets[0].url); assert.deepEqual(await page.locator('.t1-association .t1-caption .t1-source-fragment').allTextContents(), figure.caption.map(fragment => fragment.exact_quote));
    assert.equal(await page.getByRole('button', { name: /批准/ }).count(), 0); await shot('linked-figure-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('linked-figure-mobile.png'); await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('unconfirmed_associations_do_not_pair_independent_images_and_missing_figures_link_to_pdf', async () => {
    for (const association of ['no_explicit_reference', 'pending', 'not_checked']) {
      project('partial'); projectedDetail.output.records[0].association = association; projectedDetail.output.records[0].figure_ids = []; await openRun(runtime.run);
      assert.equal(await page.locator('.t1-association img').count(), 0); assert.equal(await page.getByRole('button', { name: '浏览论文原图', exact: true }).count(), 1);
    }
    project('partial'); projectedDetail.output.records[0].association = 'paired'; projectedDetail.output.records[0].figure_ids = ['engineering-unavailable-figure']; await openRun(runtime.run); await page.getByRole('button', { name: /查看对应配图/ }).click();
    assert.equal(await page.getByText('已记录配图关系，但原图暂不可用，请查看原 PDF。', { exact: false }).count(), 1); assert.equal(await page.locator('.t1-association img').count(), 0);
    project('partial'); const figure = projectedDetail.figures[0]; figure.assets = []; projectedDetail.output.records[0].association = 'paired'; projectedDetail.output.records[0].figure_ids = [figure.id]; await openRun(runtime.run); await page.getByRole('button', { name: /查看对应配图/ }).click();
    assert.equal(await page.getByText('暂未取得可用的整幅原图，请查看原 PDF。', { exact: false }).count(), 1);
  });
  await check('asset_load_failure_is_explicit_and_mobile_new_task_stays_within_viewport', async () => {
    project('partial'); const figure = projectedDetail.figures.find(item => item.assets.length); figure.assets[0].url = '/t1-engineering-missing-image.png'; projectedDetail.output.records[0].association = 'paired'; projectedDetail.output.records[0].figure_ids = [figure.id]; await openRun(runtime.run); await page.getByRole('button', { name: /查看对应配图/ }).click();
    await page.getByText('暂未取得可用的整幅原图，请查看原 PDF。', { exact: true }).waitFor();
    projectedDetail = null; await page.setViewportSize({ width: 390, height: 844 }); await newTask(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('.t1-reuse-paper').count(), 0); await shot('new-task-mobile.png');
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.status = 'passed';
} catch (error) { result.status = 'failed'; result.failure = String(error?.stack ?? error); await page.screenshot({ path: join(evidence, 'ui-browser-failure.png') }).catch(() => {}); throw error; }
finally { await persist(); await browser.close(); }
