/** Validated-build UI with browser-fulfilled APIs only. No real model or business writes. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30157';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14/item5');
const dist = 'apps/pi-web/build/summary-completion-delivery-validated-20261115', BUILD_ID = (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim();
const result = { status: 'running', BUILD_ID, dist, checks: [], errors: [], blocked: [], production_business_writes: 0, paid_calls: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const rule = 'task-flow-completion-2', batchId = '11111111-1111-4111-8111-111111111111';
const scope = { scope_version: '1', catalog_version: 'completion-fixture', matching_policy_version: 'fixture', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
const catalog = { catalog_version: scope.catalog_version, cancers: [], image_types: [], features: [], bindings: [], default_scope: scope, restricted_available: false, development_only: false };
const pdf = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf'));
const projected = (origin = 'persisted', gaps = 1, complete = true) => ({ rule_version: rule, rule_origin: origin, processing_complete: complete, source_gap_blocks: gaps, original_task_processing_complete: origin === 'persisted' ? complete : false, ...(origin === 'legacy_evidence_projection' ? { original_rule_version: 'legacy-task-completion-1' } : {}) });
async function scenario(name, specs, work, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
  const batch = specs.length > 1;
  const runs = specs.map((spec, i) => ({ run_id: 'run-' + i, document_id: 'paper-' + i, state: 'partial', fixture: true, candidate_count: 0,
    created_at: '2026-11-15T00:00:00Z', finished_at: '2026-11-15T00:00:05Z', result_ready: true, task_title: '流程核验示例', original_filename: `来源${i}.pdf`,
    model_id: 'local-only', scope, submission: batch ? { kind: 'batch', batch_id: batchId } : { kind: 'single' }, ...spec,
    progress: { schema_version: 't1-workbench-progress-1', stage: spec.state ?? 'partial', completed: 10, total: 10, completed_batches: 1, total_batches: 1, candidate_records: 0,
      source_gap_blocks: spec.task_completion?.source_gap_blocks ?? (spec.gaps ?? 0), summary_completed: spec.summary ?? true, telemetry: 'events' } }));
  const papers = runs.map(run => ({ id: run.document_id, title: run.original_filename, filename: run.original_filename, sha256: 'a'.repeat(64), uploaded: true, language: 'en', pages: 29, note: '', output_ids: [run.run_id] }));
  const detail = run => ({ run, paper: papers.find(paper => paper.id === run.document_id), output: { id: run.run_id, strategy: 'B0', origin: 'controlled_fixture', state: run.state, records: [], scope, result_ready: run.result_ready, task_completion: run.task_completion,
    coverage: { ...(run.task_processing_complete === undefined ? {} : { task_processing_complete: run.task_processing_complete }), whole_document_summary_complete: run.summary ?? true,
      source_glyph_quarantined_block_ids: Array.from({ length: run.task_completion?.source_gap_blocks ?? run.gaps ?? 0 }, (_, i) => run.run_id + '-gap-' + i), task_processing_blockers: run.blockers ?? [] },
    source_gaps: Array.from({ length: run.task_completion?.source_gap_blocks ?? run.gaps ?? 0 }, (_, i) => ({ block_id: run.run_id + '-gap-' + i, text_version: run.run_id + '-text', original_text: 'Isolated original source ' + i, physical_page: i % 29 + 1, uncertain_spans: [{ start: 0, end: 1, code: 'sparse_embedded_font_without_unicode_mapping' }] })) },
    source_units: [], figures: [], source_issues: [], source_status: 'valid', text_version: run.run_id + '-text', pdf_url: '/api/t1/workbench/papers/' + run.document_id + '/pdf' });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method(), base = '/api/t1/workbench';
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== origin || (path.startsWith('/api/') && method !== 'GET')) { result.blocked.push({ name, method, path }); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === base + '/capabilities') return json({ schema_version: 't1-workbench-capabilities-1', read_only: false, paper_upload: true, extraction_start: true, persisted_retention: true, retained_export: true, model_selection: false, max_concurrent_runs: 2 });
    if (path === base + '/catalog') return json(catalog);
    if (path === base + '/models') return json({ provider: 'fixture', default_profile_id: null, profiles: [] });
    if (path === base + '/runs') return json({ runs });
    if (path === base + '/papers') return json({ papers });
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': offline fixture\n\n' });
    if (path.endsWith('/pdf')) return route.fulfill({ contentType: 'application/pdf', body: pdf });
    const run = runs.find(item => path === base + '/runs/' + item.run_id);
    if (run) return json(detail(run));
    const paper = papers.find(item => path === base + '/papers/' + item.id);
    if (paper) return json({ paper, outputs: runs.filter(run => run.document_id === paper.id).map(run => detail(run).output), source_units: [], figures: [], source_status: 'not_parsed' });
    result.blocked.push({ name, method, path }); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => result.errors.push({ name, error: String(error) }));
  const go = async () => { await page.goto(origin + '/?paper=paper-0&run=run-0&view=records'); await page.locator(batch ? '[data-batch-results]' : '.t1-run-progress').waitFor(); if (mobile && await page.locator('.t1-sidebar').isVisible()) await page.getByRole('button', { name: '切换导航', exact: true }).click(); };
  const notes = async () => { await page.getByRole('button', { name: '说明', exact: true }).click(); return page.getByRole('dialog', { name: '说明', exact: true }); };
  try { await go(); await work({ page, notes, runs, batch }); result.checks.push({ name, status: 'passed' }); console.log('PASS ' + name); }
  catch (error) { result.checks.push({ name, status: 'failed', error: String(error) }); await page.screenshot({ path: join(evidence, 'browser-failed-' + name + '.png') }); console.log('FAIL ' + name + ' ' + error); }
  finally { await context.close(); }
}
const status = async (page, expected, outcome) => { assert.equal(await page.locator('.t1-task-progress').getAttribute('data-status'), expected); assert.equal(await page.locator('.t1-run-progress').getAttribute('data-progress-outcome'), outcome); };
try {
  await scenario('healthy_flow', [{ state: 'completed', task_processing_complete: true, task_completion: projected('persisted', 0) }], async ({ page }) => { await status(page, 'completed', 'complete'); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '100'); });
  for (const origin of ['persisted', 'legacy_evidence_projection']) await scenario(origin + '_source_gaps', [{ task_processing_complete: origin === 'persisted', task_completion: projected(origin, 41), blockers: origin === 'persisted' ? [] : ['source_glyph_quarantine_unresolved'] }], async ({ page, notes }) => {
    await status(page, 'completedWithSourceGaps', 'complete'); assert.equal(await page.locator('.t1-progress-stages [data-step="done"]').count(), 5);
    assert.match(await page.locator('[data-submission-list="sidebar"]').innerText(), /已完成·有原文缺口/);
    const rect = () => page.locator('.t1-results-panel').boundingBox(), before = await rect(), dialog = await notes();
    assert.match(await dialog.innerText(), /系统自动执行/); assert.match(await dialog.innerText(), /自动汇总核验已完成/);
    if (origin === 'legacy_evidence_projection') assert.match(await dialog.innerText(), /原始运行记录保留/);
    await dialog.locator('[data-source-gaps] summary').click(); assert.equal(await dialog.locator('[data-source-gaps] li').count(), 41);
    assert.equal(await dialog.locator('[data-source-gaps] a').first().getAttribute('href'), '/api/t1/workbench/papers/paper-0/pdf#page=1');
    assert.doesNotMatch(await dialog.innerText(), /task-flow-completion-2|run-0-gap|run-0-text|0–1|码点/); assert.deepEqual(await rect(), before);
    assert.equal(await dialog.locator('.t1-notes-content').evaluate(e => e.scrollHeight > e.clientHeight), true);
    await page.screenshot({ path: join(evidence, origin + '-desktop.png') }); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '任务与历史', exact: true }).click(); assert.match(await page.locator('[data-submission-list="history"]').innerText(), /已完成·有原文缺口/);
  });
  for (const [name, spec, expected] of [
    ['legacy_incomplete', { task_processing_complete: false, gaps: 1, blockers: ['source_glyph_quarantine_unresolved'] }, 'taskEndedIncomplete'],
    ['unknown_completion', {}, 'taskEndedUnknown'],
    ['incomplete_summary_budget', { task_processing_complete: false, summary: false, error: 'experiment_request_limit', blockers: ['summary_incomplete', 'experiment_request_limit'] }, 'taskEndedIncomplete'],
    ['finalizing', { task_processing_complete: true, result_ready: false, task_completion: projected('persisted', 0, false) }, 'taskFinalizing'],
  ]) await scenario(name, [spec], async ({ page, notes }) => {
    await status(page, expected, name === 'finalizing' ? 'active' : 'incomplete'); assert.notEqual(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '100');
    const dialog = await notes(); assert.match(await dialog.innerText(), /保留或排除记录不控制任务完成/);
    if (name === 'legacy_incomplete') { assert.match(await dialog.innerText(), /自动汇总核验已完成/); assert.match(await dialog.innerText(), /部分原文字形无法可靠识别/); }
    if (name === 'incomplete_summary_budget') assert.match(await dialog.innerText(), /达到本次请求或词元额度/);
    if (name === 'finalizing') assert.match(await dialog.innerText(), /正在保存/);
  });
  for (const allComplete of [false, true]) await scenario('batch_' + allComplete, [
    { task_processing_complete: false, task_completion: projected('legacy_evidence_projection') },
    { task_processing_complete: allComplete, ...(allComplete ? { task_completion: projected('persisted') } : { gaps: 1 }) },
  ], async ({ page, notes }) => {
    await status(page, allComplete ? 'completedWithSourceGaps' : 'taskEndedIncomplete', allComplete ? 'complete' : 'incomplete');
    assert.equal(await page.getByRole('progressbar', { name: '已结束论文', exact: true }).getAttribute('aria-valuenow'), '100');
    const dialog = await notes(); assert.equal(await dialog.locator('[data-completion-run]').count(), 2); assert.match(await dialog.innerText(), /来源0.pdf/); assert.match(await dialog.innerText(), /来源1.pdf/);
  });
  await scenario('mobile_gap_overlay', [{ task_processing_complete: false, task_completion: projected('legacy_evidence_projection', 41), blockers: ['source_glyph_quarantine_unresolved'] }], async ({ page, notes }) => {
    const before = await page.locator('.t1-results-panel').boundingBox(), dialog = await notes(); await dialog.locator('[data-source-gaps] summary').click();
    assert.deepEqual(await page.locator('.t1-results-panel').boundingBox(), before); assert.ok((await dialog.boundingBox()).height <= 844);
    await dialog.locator('[data-source-gaps] li').last().scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(evidence, 'source-gaps-mobile.png') });
  }, true);
  result.status = result.checks.every(check => check.status === 'passed') && !result.errors.length && !result.blocked.length ? 'passed' : 'failed';
} finally { await browser.close(); await writeFile(join(evidence, 'browser.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result)); }
if (result.status !== 'passed') process.exitCode = 1;
