/** Isolated saved-source browser curation. API requests are redirected to the runner-disabled 3211 test DB. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30151', backend = 'http://127.0.0.1:3211';
const evidence = join(code, 'docs/acceptance/linear-ui-2026-11-12/browser'); await mkdir(evidence, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const report = { schema_version: 't1-linear-ui-browser-1', started_at: new Date().toISOString(), origin, backend,
  data: 'Isolated DB importing existing pinned source outputs; no new medical extraction or real-user test writes',
  model_runner_available: false, paid_model_calls: 0, production_write_requests: 0, source_wording_rewritten: false,
  events_transport: 'Finite mocked SSE keepalive; persisted SSE replay is covered by the separate workflow regression',
  checks: [], screenshots: [], errors: [], failedResponses: [], expectedFailedResponses: [], blockedRequests: [] };
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.addInitScript(() => { try { localStorage.setItem('pi-theme', 'light'); localStorage.setItem('pi-locale', 'zh-CN'); } catch {} });
let stalePage, staleSnapshot, forcedDetail, exportFailure = false;
const json = async path => { const response = await fetch(backend + '/api/' + path); assert.equal(response.status, 200, path); return response.json(); };
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  if (url.origin !== origin) { report.blockedRequests.push({ method: request.method(), path, reason: 'external_origin' }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': isolated snapshot check\n\n' });
  const mutationAllowed = request.method() === 'POST' && /\/records\/[^/]+\/retention$/u.test(path);
  if (!['GET', 'HEAD'].includes(request.method()) && !mutationAllowed || /\/exports\/(?!retained_)/u.test(path)) {
    report.blockedRequests.push({ method: request.method(), path, reason: 'only_retention_mutations_and_retained_exports_allowed' }); return route.abort('blockedbyclient');
  }
  if (staleSnapshot && request.frame().page() === stalePage && path.endsWith('/runs/' + encodeURIComponent(staleSnapshot.run.run_id))) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleSnapshot) });
  }
  if (exportFailure && path.includes('/exports/')) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'source_glyph_fidelity_unverified' }) });
  if (forcedDetail && path.endsWith('/runs/' + encodeURIComponent(forcedDetail.run.run_id))) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(forcedDetail) });
  const response = await fetch(backend + path.replace(/^\/api\/t1/u, '/api') + url.search, { method: request.method(),
    ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}), headers: { 'content-type': await request.headerValue('content-type') ?? 'application/json' } });
  const headers = Object.fromEntries(['content-type', 'content-disposition'].flatMap(name => response.headers.has(name) ? [[name, response.headers.get(name)]] : []));
  return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
});
context.on('page', page => page.on('pageerror', error => report.errors.push(String(error))));
context.on('response', response => { if (response.status() >= 400 && response.status() !== 409) (exportFailure ? report.expectedFailedResponses : report.failedResponses).push({ status: response.status(), path: new URL(response.url()).pathname }); });
const page = await context.newPage();
const persist = () => writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, work) { try { const detail = await work(); report.checks.push({ name, status: 'passed', detail }); console.log('passed:', name); } catch (error) { report.checks.push({ name, status: 'failed', error: error.stack ?? String(error) }); throw error; } finally { await persist(); } }
async function open(run, record, target = page) { await target.goto(`${origin}/?${new URLSearchParams({ paper: run.document_id, run: run.run_id, view: 'records', ...(record ? { record: record.id } : {}) })}`); await target.locator('.t1-evidence-card').waitFor(); await target.evaluate(() => document.fonts.ready); }
async function choose(record) { await page.locator(`[data-index-record-id="${record.id}"]`).click(); await page.locator(`article[data-record-id="${record.id}"]`).waitFor(); }
async function exact(record, target = page) { assert.deepEqual(await target.locator('.t1-quote-frame [data-fragment-index]').allTextContents(), record.fragments.map(fragment => fragment.exact_quote)); assert.equal(await target.locator('.t1-evidence-card').getAttribute('data-record-version'), String(record.version)); }
async function mutate(target = page) {
  const response = target.waitForResponse(response => response.url().endsWith('/retention') && response.request().method() === 'POST'); await target.locator('.t1-retention [data-retention-action]').click();
  const saved = await response; assert.equal(saved.status(), 200); const value = await saved.json();
  const current = await json('workbench/runs/' + encodeURIComponent(value.record.run_id)), count = current.output.records.filter(record => record.retention.status === 'excluded').length;
  await target.waitForFunction(expected => document.querySelector('[data-retention-count="excluded"]')?.textContent === String(expected), count); return value;
}
async function view(which) { await page.locator('.t1-retention-views button').nth(which === 'kept' ? 0 : 1).click(); }
async function capture(name) { await page.locator('.t1-reader-scroll').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; })); await page.screenshot({ path: join(evidence, name) }); report.screenshots.push(name); }
async function theme(name) { await page.getByRole('button', { name: '界面主题', exact: true }).click(); await page.getByRole('menuitemradio', { name: name === 'dark' ? '深色' : '浅色', exact: true }).click(); await page.waitForFunction(value => document.documentElement.dataset.theme === value, name); }
function archiveEntries(bytes) { const tar = gunzipSync(bytes), entries = new Map(); for (let offset = 0; offset + 512 <= tar.length;) { const raw = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/s, ''); if (!raw) break; const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, '').trim() || '0', 8); entries.set(raw.replace(/^\.\//u, ''), tar.subarray(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512; } return entries; }
try {
  const caps = await json('workbench/capabilities'); assert.equal(caps.extraction_start, false); assert.equal(caps.persisted_retention, true); assert.equal(caps.retained_export, true);
  const run = (await json('workbench/runs')).runs.find(run => run.document_id === 'L07' && run.candidate_count === 26); assert.ok(run);
  const detail = await json('workbench/runs/' + encodeURIComponent(run.run_id)), records = detail.output.records;
  const current = () => json('workbench/runs/' + encodeURIComponent(run.run_id));
  const sourceRecord = records.find(record => record.fragments.length >= 4 && record.passages.length === 1); assert.ok(sourceRecord);
  report.run_id = run.run_id; report.original_records = records.length;
  await check('continuous_source_paragraphs_keep_every_original_character_and_hide_raw_offsets_in_details', async () => {
    await open(run, sourceRecord); await exact(sourceRecord);
    assert.equal(await page.locator('.t1-quote-frame .t1-source-passage').count(), sourceRecord.passages.length);
    assert.ok(sourceRecord.passages.length < sourceRecord.fragments.length);
    assert.equal(await page.locator('.t1-quote-frame details').count(), 0);
    assert.equal(await page.locator('.t1-evidence-card .t1-association').count(), 0);
    assert.equal(await page.locator('.t1-results-overview, .t1-review-intro, .t1-field-hint').count(), 0);
    assert.equal(await page.locator('.t1-quote-frame .t1-verbatim').first().evaluate(element => getComputedStyle(element).whiteSpace), 'normal');
    const gapLayout = await page.locator('.t1-quote-frame .t1-verbatim').first().evaluate(element => {
      const probe = document.createElement('span'); probe.innerHTML = '<span>A</span><span class="t1-literal-gap">\n</span><span>B</span>'; element.append(probe);
      const result = { text: probe.textContent, whiteSpace: getComputedStyle(probe.children[1]).whiteSpace,
        sameLine: probe.children[0].getBoundingClientRect().y === probe.children[2].getBoundingClientRect().y }; probe.remove(); return result;
    });
    assert.deepEqual(gapLayout, { text: 'A\nB', whiteSpace: 'normal', sameLine: true });
    assert.equal(await page.locator('.t1-review, .t1-figure-verification').count(), 0);
    assert.equal(await page.locator('.t1-retention input, .t1-retention textarea').count(), 0);
    assert.equal(await page.locator('[data-retention-count="kept"]').innerText(), '26');
    await capture('01-continuous-reading-light.png');
    const layout = await page.evaluate(() => ({ quoteTop: document.querySelector('.t1-quote-frame .t1-verbatim').getBoundingClientRect().top, footerBottom: document.querySelector('.t1-retention').getBoundingClientRect().bottom, viewportHeight: innerHeight, actionBackground: getComputedStyle(document.querySelector('[data-retention-action]')).backgroundColor }));
    assert.ok(layout.quoteTop <= 300, JSON.stringify(layout)); assert.ok(layout.footerBottom <= layout.viewportHeight); assert.notEqual(layout.actionBackground, 'rgba(0, 0, 0, 0)');
    return { layout, fragment_count: sourceRecord.fragments.length, displayed_paragraphs: sourceRecord.passages.length, quote_spelling_and_hyphens_preserved: true };
  });
  await check('notes_are_consolidated_keyboard_accessible_and_same_source_navigation_returns_to_reading', async () => {
    const group = detail.output.same_source_review_index.groups.find(group => group.member_count > 1 && group.members.some(member => member.record_id === sourceRecord.id)); assert.ok(group);
    const button = page.locator('.t1-notes-toggle'); await button.focus(); await page.keyboard.press('Enter'); await page.locator('dialog[open]').waitFor();
    assert.equal(await page.locator('.t1-notes textarea, .t1-notes input').count(), 0);
    assert.equal(await page.locator('.t1-technical-details').getAttribute('open'), null);
    assert.ok((await page.locator('.t1-notes-content').innerText()).includes('不表示已经过医学核验'));
    assert.ok((await page.locator('.t1-notes-content').innerText()).includes('尚未确认明确配图关系'));
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement)), true);
    await capture('02-consolidated-notes.png'); await page.keyboard.press('Escape'); await page.locator('dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(await button.evaluate(element => document.activeElement === element), true);
    await button.click(); await page.locator('.t1-same-source > summary').click();
    const target = group.members.find(member => member.record_id !== sourceRecord.id); await page.locator('.t1-member-list > div').filter({ has: page.locator('button[aria-pressed="false"]') }).first().locator('button').click();
    await page.locator(`article[data-record-id="${target.record_id}"]`).waitFor(); assert.equal(await page.locator('dialog[open]').count(), 0);
    const selected = records.find(record => record.id === target.record_id); await exact(selected); await choose(sourceRecord);
    return { same_source_records_remain_independent: true, member_navigation_closes_notes: true, Escape_and_focus_return: true, raw_fields_collapsed: true, new_note_inputs: 0 };
  });
  await check('next_is_navigation_only_filters_refresh_and_existing_source_drafts_survive_pdf_location', async () => {
    const before = await current(); await page.getByRole('button', { name: '下一条', exact: true }).focus(); await page.keyboard.press('Enter'); await page.locator(`article[data-record-id="${records[1].id}"]`).waitFor();
    assert.deepEqual((await current()).output.records.map(record => record.retention), before.output.records.map(record => record.retention));
    await page.getByRole('searchbox').fill('circumferential'); assert.ok(await page.locator('.t1-index-list > button').count() > 0);
    await page.getByRole('searchbox').fill('nonexistent-query-linear-test'); await page.locator('.t1-search-empty').waitFor();
    await page.reload(); await page.locator('.t1-evidence-card').waitFor(); assert.equal(await page.getByRole('searchbox').inputValue(), '');
    await choose(sourceRecord); await page.locator('.t1-notes-toggle').click(); await page.getByRole('button', { name: '修订来源或标签…', exact: true }).click();
    await page.getByRole('textbox', { name: '修订人', exact: true }).fill('isolated-unsaved-draft');
    await page.locator('.t1-source-choice .t1-link').first().click(); await page.locator('dialog[open]').waitFor({ state: 'hidden' });
    await page.locator('.t1-pdf-reader canvas').waitFor();
    await page.locator('.t1-notes-toggle').click(); await page.getByRole('button', { name: '修订来源或标签…', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '修订人', exact: true }).inputValue(), 'isolated-unsaved-draft');
    await page.keyboard.press('Escape'); await page.locator('.t1-source-toggle').click();
    await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith('t1:source-draft:')) sessionStorage.removeItem(key); });
    assert.deepEqual((await current()).output.records.map(record => record.version), before.output.records.map(record => record.version));
    return { next_retention_writes: 0, empty_filter_recovery: true, refresh_resets_query: true, unsaved_source_draft_retained: true, source_editor_writes: 0 };
  });
  await check('exclude_and_restore_move_to_the_next_neighbour_and_persist_after_refresh_without_approval', async () => {
    await choose(records[3]); const version = records[3].version, fingerprint = records[3].text_fingerprint;
    await mutate(); await page.locator(`article[data-record-id="${records[4].id}"]`).waitFor();
    let saved = (await current()).output.records.find(record => record.id === records[3].id);
    assert.equal(saved.version, version); assert.equal(saved.text_fingerprint, fingerprint); assert.equal(saved.text_approved, false); assert.equal(saved.retention.status, 'excluded');
    await page.reload(); await page.locator(`article[data-record-id="${records[4].id}"]`).waitFor();
    for (const index of [5, 7]) { await choose(records[index]); await mutate(); }
    await view('excluded'); await choose(records[5]); await mutate(); await page.locator(`article[data-record-id="${records[7].id}"]`).waitFor();
    assert.equal(await page.locator('[data-retention-count="excluded"]').innerText(), '2');
    await choose(records[3]); await mutate(); await page.locator(`article[data-record-id="${records[7].id}"]`).waitFor(); await mutate();
    await view('kept'); await page.locator('.t1-evidence-card').waitFor(); assert.equal((await current()).output.records.filter(record => record.retention.status === 'excluded').length, 0);
    return { same_evidence_version_and_fingerprint: true, middle_exclusion_next_neighbour: true, middle_restore_next_neighbour: true, refresh_persisted: true };
  });
  await check('two_tabs_cannot_overwrite_a_newer_retention_choice', async () => {
    await choose(records[9]); staleSnapshot = await current(); stalePage = await context.newPage(); await open(run, records[9], stalePage);
    await mutate();
    const conflictResponse = stalePage.waitForResponse(response => response.url().endsWith('/retention') && response.request().method() === 'POST');
    await stalePage.locator('.t1-retention [data-retention-action]').click(); assert.equal((await conflictResponse).status(), 409);
    await stalePage.locator('.t1-retention [role="alert"]').waitFor(); staleSnapshot = null;
    await stalePage.locator('.t1-retention [role="alert"] button').click(); await stalePage.waitForFunction(() => !document.querySelector('.t1-retention [role="alert"]'));
    assert.equal((await current()).output.records.find(record => record.id === records[9].id).retention.status, 'excluded');
    await stalePage.close(); stalePage = null; await page.reload(); await page.locator('.t1-evidence-card').waitFor();
    return { stale_revision_HTTP: 409, newer_choice_preserved: true, reload_clears_conflict: true };
  });
  await check('only_retained_three_formats_are_exposed_and_downloads_omit_exclusions_without_medical_confirmation', async () => {
    const labels = ['保留结果 JSONL', '保留结果 CSV', '保留结果证据包'], downloaded = [];
    await page.locator('.t1-exports > summary').click();
    assert.equal(await page.locator('.t1-export-options button').count(), 3);
    for (const [index, label] of labels.entries()) {
      const pending = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click(); const download = await pending;
      const path = join(evidence, `retained-${index}.${index === 0 ? 'jsonl' : index === 1 ? 'csv' : 'tar.gz'}`); await download.saveAs(path); assert.equal(await download.failure(), null); downloaded.push(await readFile(path));
    }
    const rows = downloaded[0].toString().trim().split('\n').map(line => JSON.parse(line)); assert.equal(rows.length, 25); assert.ok(!rows.some(record => record.record_id === records[9].id));
    assert.ok(rows.every(record => record.export_review_status === 'retained_unconfirmed' && record.human_confirmation === null && record.medical_quality_approved === false));
    assert.match(downloaded[1].toString(), /retention_status,medical_quality_approved/);
    const entries = archiveEntries(downloaded[2]), manifest = JSON.parse(entries.get('manifest.json').toString()); assert.equal(manifest.mode, 'retained'); assert.equal(manifest.record_count, 25); assert.equal(manifest.excluded_record_count, 1); assert.ok(entries.has('retention.json'));
    await page.locator('.t1-exports > summary').click();
    return { formats: ['JSONL', 'CSV', 'evidence_package'], exported_records: 25, excluded: 1, no_medical_approval_created: true, no_whole_paper_gate: true };
  });
  await check('source_and_export_problems_appear_only_when_present_and_incomplete_tasks_stay_explicit', async () => {
    assert.equal(await page.locator('.t1-export-error').count(), 0);
    assert.equal((await page.locator('.t1-exports').innerText()).includes('字形'), false);
    exportFailure = true; await page.locator('.t1-exports > summary').click(); await page.getByRole('button', { name: '保留结果 JSONL', exact: true }).click();
    await page.locator('.t1-export-error').waitFor(); assert.ok((await page.locator('.t1-export-error').innerText()).includes('字形'));
    exportFailure = false; await page.reload(); await page.locator('.t1-evidence-card').waitFor(); assert.equal(await page.locator('.t1-export-error').count(), 0);
    forcedDetail = structuredClone(await current()); forcedDetail.source_status = 'missing'; forcedDetail.source_issues = ['pdf_source_missing']; forcedDetail.output.coverage = { ...forcedDetail.output.coverage, task_processing_complete: false }; forcedDetail.run.state = 'partial';
    await page.reload(); await page.locator('.t1-source-recovery').waitFor(); assert.ok((await page.locator('.t1-content > .t1-alert').innerText()).includes('来源'));
    assert.equal(await page.locator('.t1-task-progress').getAttribute('data-status'), 'taskEndedIncomplete');
    await page.locator('.t1-exports > summary').click(); for (const button of await page.locator('.t1-export-options button').all()) assert.equal(await button.isDisabled(), true);
    forcedDetail = null; await page.reload(); await page.locator('.t1-evidence-card').waitFor();
    return { mocked_source_integrity_problem_visible: true, restore_action_available: true, incomplete_not_claimed_complete: true, export_error_revealed_after_action: true, automatic_backend_guards_covered_separately: true };
  });
  await check('three_languages_and_dark_narrow_layout_preserve_source_text', async () => {
    await choose(sourceRecord);
    for (const locale of ['en', 'zh-TW', 'zh-CN']) { await page.locator('.t1-top-actions select').selectOption(locale); await exact(sourceRecord); assert.ok(!(await page.locator('.t1-exports').innerText()).includes('t1.')); }
    await theme('dark'); await capture('05-continuous-reading-dark.png');
    for (const width of [768, 390, 320]) { await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(100); await exact(sourceRecord); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.t1-content').scrollWidth > document.querySelector('.t1-content').clientWidth + 1), false, `overflow at ${width}`); }
    await page.setViewportSize({ width: 390, height: 844 }); await theme('light'); await capture('07-mobile-light.png'); await page.setViewportSize({ width: 1440, height: 900 });
    return { locales: ['en', 'zh-TW', 'zh-CN'], widths: [1440, 768, 390, 320], source_translation: false };
  });
  await check('original_pdf_anchor_and_full_figure_remain_available_without_approval_forms', async () => {
    await page.locator('.t1-locate').click(); const physicalPage = sourceRecord.fragments[0].physical_page;
    await page.locator(`.t1-pdf-reader canvas[data-page="${physicalPage}"]`).waitFor(); await exact(sourceRecord); await page.locator('.t1-source-toggle').click();
    await page.getByRole('tab', { name: '原 Figure 目录', exact: true }).click(); await page.locator('.t1-figure').first().waitFor();
    assert.equal(await page.locator('.t1-figure input, .t1-figure textarea').count(), 0);
    return { exact_physical_page: physicalPage, PDF_SHA256: detail.paper.sha256, figure_approval_form_count: 0 };
  });
  await check('explicit_whole_figure_is_visible_in_the_reading_pane_and_source_context_remains_reachable', async () => {
    const runs = (await json('workbench/runs')).runs, figureRun = runs.find(run => run.document_id === 'L05' && run.run_id.endsWith(':L05-B0')); assert.ok(figureRun);
    const source = await json('workbench/runs/' + encodeURIComponent(figureRun.run_id)), paired = source.output.records.find(record => record.association === 'paired'); assert.ok(paired);
    await open(figureRun, paired); await exact(paired); assert.equal(await page.locator('.t1-association').getAttribute('open'), '');
    const image = page.locator('.t1-association .t1-figure img').first(); await image.waitFor(); await image.evaluate(element => element.decode());
    const geometry = await image.evaluate(element => ({ naturalRatio: element.naturalWidth / element.naturalHeight, renderedRatio: element.width / element.height })); assert.ok(Math.abs(geometry.naturalRatio - geometry.renderedRatio) < .01);
    assert.deepEqual(await page.locator('.t1-association .t1-caption [data-fragment-index]').allTextContents(), source.figures.find(figure => paired.figure_ids.includes(figure.id)).caption.map(fragment => fragment.exact_quote));
    await capture('08-explicit-figure.png');
    await image.click(); await page.locator('.image-preview-close').click();
    const contextRecord = source.output.records.find(record => record.context.length); assert.ok(contextRecord); await choose(contextRecord); await page.locator('.t1-evidence-card .t1-context > summary').click();
    assert.deepEqual(await page.locator('.t1-evidence-card .t1-context [data-fragment-index]').allTextContents(), contextRecord.context.map(fragment => fragment.exact_quote));
    await page.locator('.t1-reader-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.ok(await page.locator('[data-retention-action]').isVisible()); assert.ok((await page.locator('.t1-retention').boundingBox()).y < 900);
    return { original_full_figure_ratio: geometry, original_caption_unchanged: true, necessary_context_unchanged: true, action_footer_available_after_long_reading: true };
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.failedResponses, []); assert.deepEqual(report.blockedRequests, []);
  report.status = 'passed'; report.completed_at = new Date().toISOString();
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); throw error; }
finally { await persist(); await browser.close(); }
