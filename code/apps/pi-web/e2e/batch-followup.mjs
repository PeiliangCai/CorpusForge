/** Same production build, browser-fulfilled APIs only: no live task writes or model calls. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30157';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14'), reportPath = join(evidence, 'report.json');
const dist = 'apps/pi-web/build/batch-followup-delivery-validated-20261115', BUILD_ID = (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim();
const result = { status: 'running', BUILD_ID, dist, checks: [], errors: [], blocked: [], mock_mutations: [], production_business_writes: 0, paid_calls: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const batchId = '11111111-1111-4111-8111-111111111111';
const scope = { catalog_version: 'batch-progress-fixture', matching_policy_version: 'fixture', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
const profile = { profile_id: 'chosen-profile', provider: 'fixture', model_id: 'fixture-model', api: 'openai-responses', reasoning_effort: 'medium', context_window: 32768, max_output_tokens: 4096, configuration_source: 'server' };
const catalog = { catalog_version: scope.catalog_version, cancers: [{ id: 'lung', name: '肺癌' }], image_types: [{ id: 'ct', name: 'CT', cancer_ids: ['lung'] }], features: [], bindings: [], default_scope: scope, restricted_available: true, development_only: false };
const pdf = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf')), sha = createHash('sha256').update(pdf).digest('hex');
const fragment = (text, run, page = 1) => ({ block_id: run + text.slice(-5), text_version: run + '-text', start: 0, end: text.length, exact_quote: text, occurrence: 1, physical_page: page, bbox: [0, 0, 10, 10], location_precision: 'block' });
function seed(states) {
  const runs = states.map((value, i) => ({ run_id: 'member-' + i, document_id: 'paper-' + i, state: value.state ?? value, fixture: true, candidate_count: i < 2 ? 1 : 0,
    created_at: '2026-11-15T00:00:00Z', model_id: profile.model_id, model_profile: profile, scope, task_title: '批量核验示例', original_filename: i === states.length - 1 ? '最后一篇-' + '长文件名'.repeat(16) + '.pdf' : `论文 ${i + 1}.pdf`,
    submission: { kind: 'batch', batch_id: batchId }, result_ready: value.ready ?? !['queued', 'parsing', 'extracting', 'reconciling'].includes(value.state ?? value), ...(value.complete === undefined ? {} : { task_processing_complete: value.complete }) }));
  const papers = runs.map((run, i) => ({ id: run.document_id, title: '来源 ' + i, filename: run.original_filename, sha256: sha, language: 'en', pages: 12, note: '', uploaded: true, output_ids: [run.run_id] }));
  runs.push({ ...runs[0], run_id: 'independent-active', state: 'extracting', result_ready: false, submission: { kind: 'single' }, task_title: '同论文的独立活动任务', candidate_count: 0, task_processing_complete: undefined });
  return { runs, papers, writes: [] };
}
async function scenario(name, states, work, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', reducedMotion: 'reduce' }), state = seed(states);
  await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); localStorage.setItem('t1:extraction-model-profile', 'chosen-profile'); } }, origin);
  const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  const detail = run => ({ run, paper: state.papers.find(paper => paper.id === run.document_id), output: { id: run.run_id, strategy: 'B0', origin: 'controlled_fixture', state: run.state, scope, records: run.candidate_count ? [{ id: 'same-id', run_id: run.run_id, version: 1, fragments: [fragment('ONLY ' + run.run_id + ' original passage', run.run_id)], context: Array.from({ length: 80 }, (_, i) => fragment('Context ' + i + ' ONLY ' + run.run_id + ' source '.repeat(8), run.run_id, 2)), association: 'not_checked', figure_ids: [], proposed_figure_ids: [], reasons: [], review_status: 'pending', text_fingerprint: run.run_id, evidence_role: 'primary_candidate', retention: { status: 'kept', revision: 0, origin: 'default', record_version: 1 } }] : [], coverage: { ...(run.task_processing_complete === undefined ? {} : { task_processing_complete: run.task_processing_complete }) } }, source_units: [], figures: [], source_issues: [], source_status: 'valid', text_version: run.run_id + '-text', pdf_url: '/api/t1/workbench/papers/' + run.document_id + '/pdf' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(), base = '/api/t1/workbench';
    if (url.origin !== origin) { result.blocked.push({ name, method, path }); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (method === 'GET' && path === base + '/capabilities') return json(route, { schema_version: 't1-workbench-capabilities-1', read_only: false, paper_upload: true, extraction_start: true, persisted_review: true, persisted_retention: true, retained_export: true, model_selection: true, backend_pi_sdk: '1.4.0', max_concurrent_runs: 2 });
    if (method === 'GET' && path === base + '/catalog') return json(route, catalog);
    if (method === 'GET' && path === base + '/models') return json(route, { provider: 'fixture', default_profile_id: profile.profile_id, profiles: [profile] });
    if (method === 'GET' && path === base + '/papers') return json(route, { papers: state.papers });
    if (method === 'GET' && path === base + '/runs') return json(route, { runs: state.runs });
    if (method === 'GET' && path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (method === 'GET' && path.endsWith('/pdf')) return route.fulfill({ contentType: 'application/pdf', body: pdf });
    const runId = path.match(/^\/api\/t1\/workbench\/runs\/([^/]+)$/)?.[1], paperId = path.match(/^\/api\/t1\/workbench\/papers\/([^/]+)$/)?.[1];
    if (method === 'GET' && runId) return json(route, detail(state.runs.find(run => run.run_id === runId)));
    if (method === 'GET' && paperId) return json(route, { paper: state.papers.find(paper => paper.id === paperId), outputs: state.runs.filter(run => run.document_id === paperId).map(run => detail(run).output), source_units: [], figures: [], source_status: 'not_parsed' });
    if (method === 'DELETE' && path === base + '/batches/' + batchId) { state.writes.push({ method, path }); state.runs = state.runs.filter(run => run.submission.kind !== 'batch'); return json(route, { deleted: true, batch_id: batchId, cleanup_deferred: true }); }
    result.blocked.push({ name, method, path }); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => result.errors.push({ name, error: String(error) }));
  const go = async (view = 'records') => { await page.goto(origin + '/?paper=paper-0&run=member-0&view=' + view); await page.locator(view === 'records' ? '[data-batch-results]' : '.t1-new-task-panel:not([hidden])').waitFor(); if (viewport.width < 640 && await page.locator('.t1-sidebar').isVisible()) await page.getByRole('button', { name: '切换导航', exact: true }).click(); };
  try { await work({ page, state, go, context }); result.checks.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { result.checks.push({ name, status: 'failed', error: String(error) }); console.log('FAIL ' + name + ' ' + error); await page.screenshot({ path: join(evidence, 'batch-followup-failed-' + name + '.png') }); }
  finally { result.mock_mutations.push(...state.writes); await context.close(); }
}
const geometry = page => page.evaluate(() => Object.fromEntries(['.t1-results-panel', '.t1-record-nav', '.t1-batch-overview'].map(selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return [selector, [rect.x, rect.y, rect.width, rect.height]]; })));
async function stableOverlay(page, trigger, title, capture) {
  await trigger.scrollIntoViewIfNeeded(); const before = await geometry(page);
  await trigger.click(); const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.waitFor();
  assert.deepEqual(await geometry(page), before);
  const metrics = await dialog.locator('.t1-notes-content').evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
  assert.ok(metrics.height > 0); assert.equal(metrics.overflow, 'auto');
  if (capture) { assert.ok(metrics.scroll > metrics.height); await dialog.locator('.t1-notes-content').evaluate(element => { element.scrollTop = element.scrollHeight; }); await page.screenshot({ path: join(evidence, capture) }); }
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(await geometry(page), before); assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
  await trigger.click(); await dialog.waitFor(); await page.mouse.click(2, 2); await dialog.waitFor({ state: 'hidden' }); assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
}
try {
  assert.equal((await fetch(origin + '/_next/static/' + BUILD_ID + '/_buildManifest.js')).status, 200);
  await scenario('parallel_progress_and_finishing', ['queued', 'parsing', 'extracting', 'reconciling', { state: 'partial', complete: false }, { state: 'completed', complete: true, ready: false }, 'future'], async ({ page, go }) => {
    await go(); const bar = page.getByRole('progressbar', { name: '已结束论文', exact: true }); assert.equal(await bar.getAttribute('aria-valuenow'), '14');
    assert.match(await bar.getAttribute('aria-valuetext'), /1 \/ 7/); assert.match(await page.locator('.t1-batch-outcomes').innerText(), /收尾落盘 1 篇/); assert.match(await page.locator('.t1-batch-outcomes').innerText(), /阶段待核 1 篇/);
    assert.deepEqual(await page.locator('.t1-batch-stages small').allTextContents(), ['1 篇', '1 篇', '1 篇', '1 篇', '1 篇']);
    assert.equal(await page.locator('[data-batch-results]').getAttribute('data-progress-outcome'), 'active'); await page.screenshot({ path: join(evidence, 'batch-followup-progress-desktop.png') });
  });
  const ended = Array.from({ length: 42 }, (_, i) => i % 6 === 0 ? { state: 'completed', complete: true } : ['partial', 'failed', 'cancelled', 'interrupted', 'partial'][i % 5]);
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) await scenario('bounded_members_and_context_' + label, ended, async ({ page, go }) => {
    await go(); await page.locator('.t1-evidence-card').waitFor();
    assert.equal(await page.getByRole('progressbar', { name: '已结束论文', exact: true }).getAttribute('aria-valuenow'), '100'); assert.equal(await page.locator('[data-batch-results]').getAttribute('data-progress-outcome'), 'incomplete');
    assert.match(await page.locator('.t1-batch-progress-help').innerText(), /不代表全部论文处理完成/);
    await stableOverlay(page, page.locator('.t1-batch-overview').getByRole('button', { name: '已提交论文', exact: true }), '已提交论文', 'batch-followup-members-' + label + '.png');
    const contextTrigger = page.locator('.t1-context > button'), contextName = await contextTrigger.innerText(); await stableOverlay(page, contextTrigger, contextName, 'batch-followup-context-' + label + '.png');
    if (label === 'desktop') { await contextTrigger.click(); const dialog = page.getByRole('dialog', { name: contextName, exact: true }); await dialog.locator('.t1-fragment-location button').first().click(); await dialog.waitFor({ state: 'hidden' }); await page.locator('.t1-source').waitFor(); assert.match(await page.locator('.t1-pdf-controls').innerText(), /2/); await page.locator('.t1-source-toggle').click(); }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const ids = await page.locator('dialog').evaluateAll(dialogs => dialogs.map(dialog => dialog.getAttribute('aria-labelledby'))); assert.equal(new Set(ids).size, ids.length);
    if (label === 'desktop') { const before = await geometry(page); const about = page.locator('.t1-sidebar-bottom .t1-detail-disclosure > button'); await stableOverlay(page, about, await about.innerText()); assert.deepEqual(await geometry(page), before); }
    await page.screenshot({ path: join(evidence, 'batch-followup-' + label + '.png') });
  }, viewport);
  await scenario('delete_ended_batch_with_independent_active_sibling', ['partial', 'partial'], async ({ page, state, go }) => {
    await go(); await page.locator('[data-submission-list="sidebar"] [data-task-menu-id="batch:' + batchId + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除任务', exact: true }); await dialog.waitFor(); assert.equal(await dialog.getByRole('button', { name: '确认删除任务', exact: true }).isEnabled(), true);
    await dialog.getByRole('button', { name: '确认删除任务', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(state.writes, [{ method: 'DELETE', path: '/api/t1/workbench/batches/' + batchId }]); assert.equal(state.runs.length, 1); assert.equal(state.runs[0].run_id, 'independent-active'); assert.equal(state.runs[0].state, 'extracting');
  });
  await scenario('target_finalization_blocks_delete', [{ state: 'cancelled', ready: false }], async ({ page, go }) => {
    await go(); assert.equal(await page.getByRole('progressbar', { name: '已结束论文', exact: true }).getAttribute('aria-valuenow'), '0');
    await page.locator('[data-submission-list="sidebar"] [data-task-menu-id="batch:' + batchId + '"]').click(); await page.getByRole('menuitem', { name: '删除任务', exact: true }).click(); assert.equal(await page.getByRole('dialog', { name: '删除任务', exact: true }).getByRole('button', { name: '确认删除任务', exact: true }).isDisabled(), true); await page.keyboard.press('Escape');
  });
  await scenario('existing_scope_model_dialogs_stay_bounded', ['partial'], async ({ page, go }) => {
    await go('newTask'); const rect = () => page.locator('.t1-draft-layout').boundingBox(), before = await rect();
    for (const name of ['修改范围', '添加模型']) { const trigger = page.getByRole('button', { name, exact: true }); await trigger.click(); const dialog = page.locator('dialog[open]'); await dialog.waitFor(); assert.deepEqual(await rect(), before); assert.ok((await dialog.boundingBox()).height <= 812); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(await trigger.evaluate(element => document.activeElement === element), true); }
  });
  result.status = result.checks.every(check => check.status === 'passed') && !result.errors.length && !result.blocked.length ? 'passed' : 'failed';
} finally {
  await browser.close(); const report = JSON.parse(await readFile(reportPath, 'utf8')); report.item4.followup_batch_delete_progress_layout_20261115.browser = { ...result, completed_at_utc: new Date().toISOString() }; await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ ...result, checks: result.checks }));
}
if (result.status !== 'passed') process.exitCode = 1;
