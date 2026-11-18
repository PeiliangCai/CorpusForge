/** Validated-build UI with browser-fulfilled APIs only. No real model or business writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30158';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14/item5/paragraph-glyph-tables');
const dist = 'apps/pi-web/build/paragraph-glyph-table-values-validated-20261115', BUILD_ID = (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim();
const result = { status: 'running', BUILD_ID, dist, checks: [], errors: [], blocked: [], production_business_writes: 0, paid_calls: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const rule = 'task-flow-completion-2', batchId = '11111111-1111-4111-8111-111111111111';
const scope = { scope_version: '1', catalog_version: 'completion-fixture', matching_policy_version: 'fixture', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] } };
const catalog = { catalog_version: scope.catalog_version, cancers: [], image_types: [], features: [], bindings: [], default_scope: scope, restricted_available: false, development_only: false };
const pdf = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf'));
const pdfSha = createHash('sha256').update(pdf).digest('hex');
const projected = (origin = 'persisted', gaps = 1, complete = true) => ({ rule_version: rule, rule_origin: origin, processing_complete: complete, source_gap_blocks: gaps, original_task_processing_complete: origin === 'persisted' ? complete : false, ...(origin === 'legacy_evidence_projection' ? { original_rule_version: 'legacy-task-completion-1' } : {}) });
async function scenario(name, specs, work, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
  await context.addInitScript(() => { window.__openedSourceUrls = []; window.open = url => { window.__openedSourceUrls.push(String(url)); return null; }; });
  const batch = specs.length > 1;
  const runs = specs.map((spec, i) => ({ run_id: 'run-' + i, document_id: 'paper-' + i, state: 'partial', fixture: true, candidate_count: 0,
    created_at: '2026-11-15T00:00:00Z', finished_at: '2026-11-15T00:00:05Z', result_ready: true, task_title: '段落与表格核验示例', original_filename: `来源${i}.pdf`,
    model_id: 'local-only', scope, submission: batch ? { kind: 'batch', batch_id: batchId } : { kind: 'single' }, ...spec,
    summary: spec.summary ?? !['queued', 'parsing', 'extracting'].includes(spec.state ?? 'partial'),
    progress: { schema_version: 't1-workbench-progress-1', stage: spec.state ?? 'partial', completed: 10, total: 10, completed_batches: 1, total_batches: 1, candidate_records: spec.candidate_count ?? 0,
      source_gap_blocks: spec.task_completion?.source_gap_blocks ?? (spec.gaps ?? 0), summary_completed: spec.summary ?? !['queued', 'parsing', 'extracting'].includes(spec.state ?? 'partial'), telemetry: 'events', ...(spec.progress ?? {}) } }));
  const papers = runs.map(run => ({ id: run.document_id, title: run.original_filename, filename: run.original_filename, sha256: pdfSha, uploaded: true, language: 'en', pages: 4, note: '', output_ids: [run.run_id] }));
  const detail = run => ({ run, paper: papers.find(paper => paper.id === run.document_id), output: { id: run.run_id, strategy: 'B0', origin: 'controlled_fixture', state: run.state, records: run.records ?? [], scope, result_ready: run.result_ready, task_completion: run.task_completion,
    coverage: { ...(run.task_processing_complete === undefined ? {} : { task_processing_complete: run.task_processing_complete }), whole_document_summary_complete: run.summary ?? true,
      source_glyph_quarantined_block_ids: Array.from({ length: run.task_completion?.source_gap_blocks ?? run.gaps ?? 0 }, (_, i) => run.run_id + '-gap-' + i), task_processing_blockers: run.blockers ?? [], ...(run.coverage ?? {}) },
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
  catch (error) { result.checks.push({ name, status: 'failed', error: String(error), stack: error.stack }); await page.screenshot({ path: join(evidence, 'browser-failed-' + name + '.png') }); console.log('FAIL ' + name + ' ' + error); }
  finally { await context.close(); }
}
const status = async (page, expected, outcome) => { assert.equal(await page.locator('.t1-task-progress').getAttribute('data-status'), expected); assert.equal(await page.locator('.t1-run-progress').getAttribute('data-progress-outcome'), outcome); };
let fragmentId = 0;
const fragment = (text, page = 1) => ({ block_id: 'internal-block-' + (++fragmentId), text_version: 'internal-text-version', exact_quote: text, start: 0, end: Array.from(text).length, physical_page: page, occurrence: 0, bbox: [10, 10, 500, 25], location_precision: 'whole_textline_not_exact_glyph' });
const original = 'CT shows round nodules in the two described groups.';
const tableRecord = { id: 'supported-description', run_id: 'run-0', version: 1, actor: 'automatic', fragments: [fragment(original)], context: [fragment('Their diameters are given in Table 2.')],
  association: 'not_checked', figure_ids: [], proposed_figure_ids: [], reasons: [], review_status: 'pending', text_fingerprint: 'fixture', evidence_role: 'primary_candidate',
  text_approved: false, figures_approved: false, labels: {}, retention: { status: 'kept', revision: 0, origin: 'default', record_version: 1 }, source_unit_ids: [], context_unit_ids: [],
  supporting_table_evidence: [{ table_id: 'private-table-id', selected_cell_ids: ['private-cell-a', 'private-cell-b'], reference_evidence: [fragment('Their diameters are given in Table 2.')],
    fragments: [fragment('4.2 ± 1.1', 2), fragment('5.5 ± 1.2', 2)], context_fragments: [fragment('Group Alpha: CT, Case 1', 2), fragment('Group Beta: CT, Case 1', 2), fragment('Diameter (mm)', 2), ...Array.from({ length: 14 }, (_, i) => fragment(`* Original note ${i}: values are mean ± SD; units are mm.`, 2))],
    relationship_status: 'explicit_reference_value_relationship_unverified' }] };
const linked = tableRecord.supporting_table_evidence[0];
linked.description_evidence = tableRecord.fragments;
linked.value_contexts = linked.fragments.map((value, i) => ({ cell_id: linked.selected_cell_ids[i], row_start: i + 1, row_end: i + 2, col_start: 1, col_end: 2,
  mapping_status: 'native_mapping_unapproved', fragments: [value], context_fragments: [linked.context_fragments[i], linked.context_fragments[2]] }));
try {
  await scenario('actual_paragraph_count', [{ state: 'extracting', result_ready: false, progress: { unit: 'paragraphs', completed: 2, total: 5 }, coverage: { progress_unit: 'paragraphs', dispatched_paragraphs: 5, explicitly_completed_paragraphs: 2, explicitly_completed_source_blocks: 20, dispatched_source_blocks: 48 } }], async ({ page, notes }) => {
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '40');
    assert.match(await page.locator('.t1-progress-detail').innerText(), /2\s*\/\s*5.*内容块/); assert.doesNotMatch(await page.locator('.t1-progress-detail').innerText(), /20\s*\/\s*48/);
    const dialog = await notes(); assert.match(await dialog.innerText(), /长段的全部句子分片完成后才计入/); assert.doesNotMatch(await dialog.innerText(), /自动汇总核验已完成/); assert.match(await dialog.innerText(), /自动汇总核验尚未.*完成/);
    await page.screenshot({ path: join(evidence, 'paragraph-progress-desktop.png') });
  });
  await scenario('legacy_line_count', [{ state: 'extracting', result_ready: false, progress: { unit: 'source_blocks', completed: 27, total: 30 } }], async ({ page, notes }) => {
    assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '90'); assert.match(await page.locator('.t1-progress-detail').innerText(), /27\s*\/\s*30.*行/);
    assert.match(await (await notes()).innerText(), /历史.*原文行/);
  });
  await scenario('unfinished_parent_stays_incomplete', [{ task_processing_complete: false, progress: { unit: 'paragraphs', completed: 0, total: 1 }, summary: false, blockers: ['selected_input_processing_incomplete'] }], async ({ page }) => {
    await status(page, 'taskEndedIncomplete', 'incomplete'); assert.notEqual(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '100');
    assert.match(await page.locator('.t1-progress-detail').innerText(), /0\s*\/\s*1.*内容块/);
  });
  for (const ruleOrigin of ['persisted', 'legacy_evidence_projection']) await scenario('glyph_background_' + ruleOrigin, [{ task_processing_complete: ruleOrigin === 'persisted', task_completion: projected(ruleOrigin, 41),
    coverage: { source_glyph_issue_block_ids: ['private-glyph-block'], source_glyph_policy_version: 'agent-assesses-parsed-glyphs-1' }, blockers: ruleOrigin === 'persisted' ? [] : ['source_glyph_quarantine_unresolved'] }], async ({ page, notes }) => {
    await status(page, 'completed', 'complete'); assert.doesNotMatch(await page.locator('[data-submission-list="sidebar"]').innerText(), /有原文缺口|字形|人工核验/);
    assert.equal(await page.locator('.t1-progress-gap').count(), 0);
    const dialog = await notes(); assert.match(await dialog.innerText(), /系统自动执行/); assert.equal(await dialog.locator('[data-source-gaps]').count(), 0);
    assert.doesNotMatch(await dialog.innerText(), /private-glyph|41处|存疑|字形|task-flow-completion-2/);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '任务与历史', exact: true }).click();
    assert.doesNotMatch(await page.locator('[data-submission-list="history"]').innerText(), /有原文缺口|字形|人工核验/);
  });
  await scenario('final_save_remains_pending', [{ task_processing_complete: true, result_ready: false, task_completion: projected('persisted', 0, false) }], async ({ page, notes }) => {
    await status(page, 'taskFinalizing', 'active'); assert.notEqual(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '100');
    assert.match(await (await notes()).innerText(), /正在保存/);
  });
  for (const mobile of [false, true]) await scenario('same_record_table_' + (mobile ? 'mobile' : 'desktop'), [{ state: 'completed', candidate_count: 1, task_processing_complete: true,
    task_completion: projected('persisted', 0), records: [tableRecord], progress: { unit: 'paragraphs', completed: 4, total: 4 } }], async ({ page }) => {
    await page.locator('.t1-table-support').waitFor(); assert.equal(await page.locator('.t1-evidence-card').count(), 1);
    assert.equal(await page.locator('.t1-record-selector option').count(), 1);
    assert.equal(await page.locator('.t1-quote-frame .t1-source-fragment').innerText(), original);
    const preview = page.locator('.t1-table-support-preview'); const text = await preview.innerText();
    for (const expected of ['表 2', '4.2 ± 1.1', '5.5 ± 1.2', 'Diameter (mm)', 'Group Alpha', 'Group Beta']) assert.ok(text.includes(expected), expected);
    assert.equal(await preview.locator('[data-table-value-index]').count(), 2);
    const alpha = await preview.locator('[data-table-value-index="0"]').innerText(), beta = await preview.locator('[data-table-value-index="1"]').innerText();
    assert.ok(alpha.includes('Group Alpha') && alpha.includes('4.2 ± 1.1') && alpha.includes('Diameter (mm)')); assert.doesNotMatch(alpha, /Group Beta|5.5 ± 1.2/);
    assert.ok(beta.includes('Group Beta') && beta.includes('5.5 ± 1.2') && beta.includes('Diameter (mm)')); assert.doesNotMatch(beta, /Group Alpha|4.2 ± 1.1/);
    assert.doesNotMatch(text, /private-table-id|private-cell|internal-block|internal-text-version|offset|paragraph-linked-table-support/);
    const size = await preview.evaluate(e => ({ h: e.clientHeight, scroll: e.scrollHeight, overflow: getComputedStyle(e).overflowY })); assert.ok(size.h <= 168 && size.scroll > size.h); assert.equal(size.overflow, 'auto');
    const before = await page.locator('.t1-results-panel').boundingBox(); await page.getByRole('button', { name: '表格补充详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '表格补充详情', exact: true }); await dialog.waitFor();
    assert.deepEqual(await page.locator('.t1-results-panel').boundingBox(), before); assert.ok((await dialog.boundingBox()).height <= (mobile ? 844 : 1000));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(evidence, 'table-support-' + (mobile ? 'mobile' : 'desktop') + '.png') });
    await page.keyboard.press('Escape'); assert.deepEqual(await page.locator('.t1-results-panel').boundingBox(), before);
    await page.screenshot({ path: join(evidence, 'table-preview-' + (mobile ? 'mobile' : 'desktop') + '.png') });
    await preview.getByRole('button', { name: '第 2 物理页 ↗', exact: true }).first().click();
    if (mobile) assert.ok((await page.evaluate(() => window.__openedSourceUrls)).some(url => url.endsWith('/api/t1/workbench/papers/paper-0/pdf#page=2')));
    else { await page.locator('.t1-source canvas[data-page="2"]').waitFor({ state: 'visible', timeout: 20000 }); assert.equal(await page.locator('.t1-source').isVisible(), true); }
    await page.screenshot({ path: join(evidence, 'table-source-page-' + (mobile ? 'mobile' : 'desktop') + '.png') });
  }, mobile);
  result.status = result.checks.every(check => check.status === 'passed') && !result.errors.length && !result.blocked.length ? 'passed' : 'failed';
} finally { await browser.close(); await writeFile(join(evidence, 'browser.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result)); }
if (result.status !== 'passed') process.exitCode = 1;
